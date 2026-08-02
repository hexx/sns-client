/**
 * Nostr 読み取り専用 Provider の取得・検証・変換ロジック（shared。docs/nostr-browser-direct-spec.md、ADR-0014）。
 *
 * - ブラウザがリレー群へ直接 WebSocket を開き（WsFactory 注入、§6.2）、NIP-01 REQ でイベントを収集する。
 * - 収集したイベントは id で重複排除し、schnorr 署名＋ id 再計算で全件検証する（§6.2 ステップ4-5）。
 * - kind 1 を Post に、kind 6 を repostedBy として包む（§6.5）。kind 0 で Author を解決する（§6.4）。
 * - 鍵（nsec）は一切扱わない。閲覧は署名不要。
 * - Worker 専用 API は持たない（wsFactory は必須。ブラウザ版は app/src/lib/nostrWs.ts）。
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32 } from '@scure/base';
import type { Author, Media, Post, Profile, RichSegment, Source, ThreadNode, ThreadResponse, TimelineResponse } from './types';

// --- 定数（§6.1 固定リレーセット / §6.2 収集ウィンドウ） ---
export const NOSTR_RELAYS = [
  'wss://yabu.me',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.hiroba.media',
];
const COLLECT_TIMEOUT_MS = 4000;
const PAGE_SIZE = 30;
const FETCH_LIMIT = PAGE_SIZE * 3; // 重複排除・kind6解決後の欠損を見込んだ余裕
const THREAD_ANCESTOR_LIMIT = 25; // 祖先の遡上上限（bsky parentHeight / misskey limit と同値。docs/thread-view-spec.md §5）
const THREAD_CHILDREN_LIMIT = 30; // 子孫の1バッチ上限（他 Provider の limit と同値）
const PROFILE_TTL_MS = 30 * 60 * 1000; // ADR-0006 準拠（30分）
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)([?#].*)?$/i;

// --- ドメイン型 ---
export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type NostrFilter = {
  kinds?: number[];
  authors?: string[];
  ids?: string[];
  until?: number;
  limit?: number;
  /** NIP-01 タグフィルタ: 指定 id を e タグで参照するイベント（スレッド子孫の収集。docs/thread-view-spec.md §5） */
  '#e'?: string[];
};

type NostrProfile = { displayName?: string; picture?: string; about?: string; banner?: string };

/** nostr Source の検証エラー（BFF が status にマップする。MisskeyApiError 同型） */
export class NostrError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- hex helpers（Worker に Buffer は無い） ---
function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// --- bech32（NIP-19） ---
export function decodeNpub(input: string): string {
  const { prefix, words } = bech32.decode(input, 5000);
  if (prefix !== 'npub') throw new Error(`not an npub: ${prefix}`);
  return toHex(bech32.fromWords(words));
}
function npubOf(pubkeyHex: string): string {
  return bech32.encode('npub', bech32.toWords(fromHex(pubkeyHex)), 5000);
}
/** 表示用の npub 短縮（§6.4: 先頭12＋…＋末尾4） */
export function shortenNpub(pubkeyHex: string): string {
  try {
    return shortenBech(npubOf(pubkeyHex));
  } catch {
    return `${pubkeyHex.slice(0, 8)}…`;
  }
}
function shortenBech(s: string): string {
  return s.length > 20 ? `${s.slice(0, 12)}…${s.slice(-4)}` : s;
}

// --- イベント検証（§6.2 ステップ5: id 再計算＋schnorr） ---
export function verifyEvent(ev: NostrEvent): boolean {
  try {
    if (!/^[0-9a-f]{64}$/.test(ev.id)) return false;
    if (!/^[0-9a-f]{64}$/.test(ev.pubkey)) return false;
    if (!/^[0-9a-f]{128}$/.test(ev.sig)) return false;
    const serialized = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
    const id = toHex(sha256(new TextEncoder().encode(serialized)));
    if (id !== ev.id) return false;
    return schnorr.verify(fromHex(ev.sig), fromHex(ev.id), fromHex(ev.pubkey));
  } catch {
    return false;
  }
}

// --- WebSocket 抽象（テストで差し替え可能。既定は Worker の outbound WS） ---
export type WsLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
};
export type WsFactory = (url: string) => Promise<WsLike>;

/**
 * 複数リレーへ並列に REQ を投げ、EOSE またはタイムアウトまで収集して閉じる（§6.2）。
 * 到達不能リレーは黙ってスキップ、id で重複排除、署名検証済みのイベントだけを返す。
 */
export async function queryRelays(
  urls: string[],
  filter: NostrFilter,
  opts: { timeoutMs?: number; wsFactory: WsFactory; outcomes?: Map<string, boolean> },
): Promise<NostrEvent[]> {
  const timeoutMs = opts.timeoutMs ?? COLLECT_TIMEOUT_MS;
  const factory = opts.wsFactory;
  const sink = new Map<string, NostrEvent>();
  await Promise.allSettled(urls.map((u) => queryOne(u, filter, factory, sink, timeoutMs, opts.outcomes)));
  const out: NostrEvent[] = [];
  for (const ev of sink.values()) if (verifyEvent(ev)) out.push(ev);
  return out;
}

function queryOne(
  url: string,
  filter: NostrFilter,
  factory: WsFactory,
  sink: Map<string, NostrEvent>,
  timeoutMs: number,
  outcomes?: Map<string, boolean>,
): Promise<void> {
  return factory(url)
    .catch(() => {
      outcomes?.set(url, false); // 接続失敗（ブラウザ直結ではネットワーク制限・リレーダウン等）
      return undefined;
    })
    .then(
      (ws) =>
        new Promise<void>((resolve) => {
          if (!ws) {
            resolve();
            return;
          }
          outcomes?.set(url, true); // ハンドシェイク成功
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            resolve();
          };
          const timer = setTimeout(finish, timeoutMs);
          const stop = () => {
            clearTimeout(timer);
            finish();
          };
          ws.addEventListener('message', (ev) => {
            let msg: unknown;
            try {
              msg = JSON.parse(String(ev.data));
            } catch {
              return;
            }
            if (!Array.isArray(msg)) return;
            if (msg[0] === 'EVENT' && msg[2] && typeof msg[2] === 'object') {
              const e = msg[2] as NostrEvent;
              if (typeof e.id === 'string' && !sink.has(e.id)) sink.set(e.id, e);
            } else if (msg[0] === 'EOSE') {
              stop();
            }
          });
          ws.addEventListener('close', stop);
          ws.addEventListener('error', stop);
          try {
            ws.send(JSON.stringify(['REQ', 'sns', filter]));
          } catch {
            stop();
          }
        }),
    );
}

// --- kind 0 プロフィール（§6.4: TTL キャッシュ＋バッチ取得） ---
const profileCache = new Map<string, { at: number; profile: NostrProfile }>();
const CACHE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweep = 0;

/** 期限切れエントリの掃き出し（無制限成長の抑制。高々10分に1度） */
function sweepExpiredProfiles(now: number): void {
  if (now - lastSweep < CACHE_SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [k, v] of profileCache) if (now - v.at >= PROFILE_TTL_MS) profileCache.delete(k);
}

/** テスト用: プロフィールキャッシュをクリアする */
export function resetProfileCache(): void {
  profileCache.clear();
  lastSweep = 0;
}

export function parseProfile(content?: string): NostrProfile {
  if (!content) return {};
  try {
    const j = JSON.parse(content) as {
      display_name?: string;
      name?: string;
      picture?: string;
      about?: string;
      banner?: string;
    };
    const p: NostrProfile = {};
    const dn = j.display_name || j.name;
    if (typeof dn === 'string' && dn.length > 0) p.displayName = dn;
    if (typeof j.picture === 'string' && j.picture.length > 0) p.picture = j.picture;
    // 自己紹介・バナーはプロフィール表示で使う（docs/profile-view-spec.md §7）
    if (typeof j.about === 'string' && j.about.length > 0) p.about = j.about;
    if (typeof j.banner === 'string' && j.banner.length > 0) p.banner = j.banner;
    return p;
  } catch {
    return {};
  }
}

async function loadProfiles(
  pubkeys: string[],
  urls: string[],
  factory: WsFactory,
): Promise<Map<string, NostrProfile>> {
  sweepExpiredProfiles(Date.now());
  const result = new Map<string, NostrProfile>();
  const missing: string[] = [];
  for (const pk of pubkeys) {
    const c = profileCache.get(pk);
    if (c && Date.now() - c.at < PROFILE_TTL_MS) result.set(pk, c.profile);
    else missing.push(pk);
  }
  if (missing.length > 0) {
    const evs = await queryRelays(urls, { kinds: [0], authors: missing }, { wsFactory: factory });
    const latest = new Map<string, NostrEvent>();
    for (const ev of evs) {
      const cur = latest.get(ev.pubkey);
      if (!cur || ev.created_at > cur.created_at) latest.set(ev.pubkey, ev);
    }
    for (const pk of missing) {
      const profile = parseProfile(latest.get(pk)?.content);
      profileCache.set(pk, { at: Date.now(), profile });
      result.set(pk, profile);
    }
  }
  return result;
}

// --- 本文 → 統一リッチテキスト（§6.3、ADR-0005） ---
/** URL 末尾の句読点を本文側へ剥がす（文中 URL の末尾に続く `. , ! ?` 等をリンクに巻き込まないため）。
 *  閉じ括弧は URL 内で開きより閉じが多いときだけ剥がす（`.../Foo_(bar)` のような正規 URL を壊さない）。 */
const URL_TRAILING_PUNCT = '.,;:!?\'"、。，．！？';
function splitUrlPunctuation(tok: string): { url: string; rest: string } {
  let end = tok.length;
  while (end > 0) {
    const ch = tok[end - 1];
    if (URL_TRAILING_PUNCT.includes(ch)) {
      end--;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      const slice = tok.slice(0, end);
      const opens = slice.split(open).length - 1;
      const closes = slice.split(ch).length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return { url: tok.slice(0, end), rest: tok.slice(end) };
}

export function toSegments(content: string): { text: string; rich: RichSegment[]; media: Media[] } {
  const rich: RichSegment[] = [];
  const media: Media[] = [];
  let plain = '';
  const pushText = (t: string) => {
    if (t.length === 0) return;
    const last = rich[rich.length - 1];
    if (last && last.type === 'text') last.text += t;
    else rich.push({ type: 'text', text: t });
    plain += t;
  };
  const re =
    /(nostr:n(?:pub|profile|ote|event|addr)1[023456789acdefghjklmnpqrstuvwxyz]+)|(https?:\/\/[^\s<]+)|(#[\p{L}\p{N}_]+)/giu;
  let last = 0;
  for (const m of content.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) pushText(content.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith('nostr:')) {
      const entity = tok.slice(6);
      if (entity.startsWith('npub1') || entity.startsWith('nprofile1')) {
        const handle = shortenBech(entity);
        rich.push({ type: 'mention', handle });
        plain += `@${handle}`;
      } else {
        rich.push({ type: 'link', url: tok, text: shortenBech(entity) });
        plain += tok;
      }
    } else if (tok.startsWith('http')) {
      const { url, rest } = splitUrlPunctuation(tok);
      if (IMAGE_EXT.test(url)) {
        media.push({ type: 'image', url }); // 本文からは除去（§5.2）。末尾句読点も本文に残さない
      } else {
        rich.push({ type: 'link', url });
        plain += url;
        if (rest) pushText(rest); // 剥がした末尾句読点は本文へ戻す
      }
    } else {
      rich.push({ type: 'hashtag', tag: tok.slice(1) });
      plain += tok;
    }
    last = idx + tok.length;
  }
  if (last < content.length) pushText(content.slice(last));
  return { text: plain.trim(), rich, media };
}

// --- Post 組み立て ---
function toAuthor(pubkeyHex: string, profile?: NostrProfile): Author {
  const handle = shortenNpub(pubkeyHex);
  const a: Author = { id: pubkeyHex, handle, displayName: profile?.displayName || handle };
  if (profile?.picture) a.avatarUrl = profile.picture;
  return a;
}

function buildPost(ev: NostrEvent, profile: NostrProfile | undefined, repostedBy?: Author): Post {
  const { text, rich, media } = toSegments(ev.content);
  const post: Post = {
    id: ev.id,
    provider: 'nostr',
    author: toAuthor(ev.pubkey, profile),
    text,
    rich,
    createdAt: new Date(ev.created_at * 1000).toISOString(),
    media,
    stats: { replies: 0, reposts: 0, likes: 0 },
    ref: ev.id,
    source: ev,
  };
  if (repostedBy) post.repostedBy = repostedBy;
  return post;
}

function eTagId(ev: NostrEvent): string | undefined {
  const id = ev.tags.find((t) => t[0] === 'e')?.[1];
  return id && /^[0-9a-f]{64}$/.test(id) ? id : undefined;
}

/**
 * nostr Source のタイムライン取得（§6.2 全体フロー）。
 * pubkey Source は固定リレーセットから kind 1+6、relay Source は指定リレーから kind 1 を集める。
 */
export async function getTimeline(
  source: Source,
  cursor?: string,
  opts?: { wsFactory: WsFactory },
): Promise<TimelineResponse> {
  if (!opts) throw new NostrError(400, 'wsFactory is required');
  const until = cursor ? Number.parseInt(cursor, 10) : undefined;
  let urls: string[];
  let filter: NostrFilter;
  if (source.kind === 'pubkey') {
    if (!source.id) throw new NostrError(400, 'pubkey source requires id');
    let author: string;
    try {
      author = decodeNpub(source.id);
    } catch {
      throw new NostrError(400, 'invalid npub');
    }
    urls = NOSTR_RELAYS;
    filter = { kinds: [1, 6], authors: [author], limit: FETCH_LIMIT };
  } else if (source.kind === 'relay') {
    if (!source.id) throw new NostrError(400, 'relay source requires id');
    urls = [source.id];
    filter = { kinds: [1], limit: FETCH_LIMIT };
  } else {
    throw new NostrError(400, `invalid nostr source kind: ${source.kind}`);
  }
  if (until && !Number.isNaN(until)) filter.until = until;

  const outcomes = new Map<string, boolean>();
  const events = await queryRelays(urls, filter, { wsFactory: opts.wsFactory, outcomes });

  // 接続失敗の表出（docs/nostr-browser-direct-spec.md §6.5、ADR-0014）。
  // relay Source（単一リレー）は接続失敗を可視エラー化、pubkey Source（複数リレー）は全滅時のみエラー。
  if (source.kind === 'relay') {
    if (outcomes.get(urls[0]) === false) {
      throw new NostrError(
        502,
        `リレーに接続できません（現在のネットワークから到達できない可能性があります）: ${urls[0]}`,
      );
    }
  } else if (urls.length > 0 && urls.every((u) => outcomes.get(u) === false)) {
    throw new NostrError(502, 'いずれのリレーにも接続できません（ネットワーク接続を確認してください）');
  }

  const { posts } = await buildFeedPosts(events, urls, opts.wsFactory);
  const page = posts.slice(0, PAGE_SIZE);
  // 表示順（リポストは元ノートの日時）ベースの cursor（既存挙動。TimelineCore は pid で dedup するため
  // 境界の再取得は表示に現れない。リポストの raw 日時と表示位置の乖離による欠落は既知の制限）
  const nextCursor =
    page.length > 0 ? String(Math.floor(Date.parse(page[page.length - 1].createdAt) / 1000)) : null;
  return { posts: page, nextCursor };
}

/**
 * kind:1＋kind:6 のイベント列から投稿一覧を組み立てる共通処理（§6.5、docs/profile-view-spec.md §7）。
 * - kind:6 の参照先（元ノート）を ids でバッチ取得し、repostedBy として包む。
 * - 登場する全 pubkey のプロフィールをまとめて解決（§6.4。TTL キャッシュ）。
 * - 自分の投稿の自己リポスト・同一元ノートへの複数リポストは元の投稿と重複するためスキップ。
 * - 時系列降順で返し、各投稿の「生イベントの created_at」も併せて返す（ページング cursor は
 *   表示日時（リポストは元ノートの日時）ではなく生イベントの日時から求める必要があるため）。
 *   getTimeline（pubkey Source）と getProfilePosts が共用する。
 */
async function buildFeedPosts(
  events: NostrEvent[],
  urls: string[],
  factory: WsFactory,
): Promise<{ posts: Post[]; rawTimes: number[] }> {
  const kind1 = events.filter((e) => e.kind === 1);
  const kind6 = events.filter((e) => e.kind === 6);

  // kind 6 の参照先（元ノート）を ids でバッチ取得（§6.5）
  const refs = [...new Set(kind6.map(eTagId).filter((x): x is string => Boolean(x)))];
  const originals = new Map<string, NostrEvent>();
  if (refs.length > 0) {
    for (const ev of await queryRelays(urls, { kinds: [1], ids: refs }, { wsFactory: factory })) {
      originals.set(ev.id, ev);
    }
  }

  // 登場する全 pubkey のプロフィールをまとめて解決（§6.4）
  const pubkeys = new Set<string>();
  for (const e of kind1) pubkeys.add(e.pubkey);
  for (const e of kind6) pubkeys.add(e.pubkey);
  for (const e of originals.values()) pubkeys.add(e.pubkey);
  const profiles = await loadProfiles([...pubkeys], urls, factory);

  const posts: Post[] = [];
  const rawTimes: number[] = [];
  const seen = new Set<string>(); // 元ノート id（同一ノートの重複表示を防ぐ）
  for (const e of kind1) {
    const p = buildPost(e, profiles.get(e.pubkey));
    seen.add(p.id);
    posts.push(p);
    rawTimes.push(e.created_at);
  }
  for (const e of kind6) {
    const orig = originals.get(eTagId(e) ?? '');
    if (!orig) continue; // 参照先未取得のリポストはスキップ（§6.5）
    if (seen.has(orig.id)) continue; // 元ノートが既に表示済み（自己リポスト・複数リポスト）ならスキップ
    seen.add(orig.id);
    posts.push(buildPost(orig, profiles.get(orig.pubkey), toAuthor(e.pubkey, profiles.get(e.pubkey))));
    rawTimes.push(e.created_at); // リポストは「リポストした生イベント」の日時でページングする
  }

  const order = posts
    .map((_, i) => i)
    .toSorted((a, b) => Date.parse(posts[b].createdAt) - Date.parse(posts[a].createdAt));
  return { posts: order.map((i) => posts[i]), rawTimes: order.map((i) => rawTimes[i]) };
}

/** ページの cursor（生イベントの最古 created_at - 1。until は境界を含むため、境界イベントの再取得を防ぐ）。
 * 注意: 同一秒に複数イベントがありリレーが FETCH_LIMIT で打ち切った場合、その秒の残りは次ページで
 * 欠落しうる（既知の制限。ProfileView は追記を pid で重複排除しないため、境界再取得より欠落を選ぶ）。 */
function pageCursor(rawTimes: number[]): string | null {
  if (rawTimes.length === 0) return null;
  return String(Math.min(...rawTimes) - 1);
}

// --- プロフィール（docs/profile-view-spec.md §7、ADR-0014/0017） ---

/**
 * nostr プロフィールのブラウザ直接解決。kind:0 を固定リレーセットから照会し、
 * 他 Provider と同じ統一 Profile を組み立てる。カウント（stats）・viewer・permalink は
 * リレーに無いため持たない（§7）。リレーに kind:0 が無い（または全滅）場合は handle のみに縮退。
 * 取得は loadProfiles（TTL キャッシュ＋バッチ）を経由し、投稿一覧側の解決とキャッシュを共有する（§6.4）。
 */
export async function getProfile(pubkeyHex: string, opts: { wsFactory: WsFactory }): Promise<Profile> {
  const profiles = await loadProfiles([pubkeyHex], NOSTR_RELAYS, opts.wsFactory);
  const profile = profiles.get(pubkeyHex) ?? {};
  const out: Profile = { provider: 'nostr', author: toAuthor(pubkeyHex, profile) };
  if (profile.about) out.description = profile.about;
  if (profile.banner) out.bannerUrl = profile.banner;
  return out;
}

/**
 * nostr プロフィールの投稿一覧（kind:1＋kind:6 を pubkey で照会。§7）。
 * ページングは getTimeline と同じ until（created_at の unix 秒）を cursor として継続する
 * （NIP-01 の until＋limit。リレーの標準機能で追加読み込みが可能）。
 */
export async function getProfilePosts(
  pubkeyHex: string,
  opts: { wsFactory: WsFactory },
  cursor?: string,
): Promise<TimelineResponse> {
  const urls = NOSTR_RELAYS;
  const until = cursor ? Number.parseInt(cursor, 10) : undefined;
  const filter: NostrFilter = { kinds: [1, 6], authors: [pubkeyHex], limit: FETCH_LIMIT };
  if (until && !Number.isNaN(until)) filter.until = until;
  const outcomes = new Map<string, boolean>();
  const events = await queryRelays(urls, filter, { wsFactory: opts.wsFactory, outcomes });
  if (urls.length > 0 && urls.every((u) => outcomes.get(u) === false)) {
    throw new NostrError(502, 'いずれのリレーにも接続できません（ネットワーク接続を確認してください）');
  }
  const { posts, rawTimes } = await buildFeedPosts(events, urls, opts.wsFactory);
  // ページは取得上限（FETCH_LIMIT）のまま全件返す: リポストは raw 日時（リレーの until 対象）と
  // 表示位置（元ノートの日時）が乖離するため、表示順でスライスすると深いページでリポストが
  // 欠落する（until フィルタに掛かる）。raw ウィンドウで区切り、ページ内は表示順で整列する。
  const nextCursor = pageCursor(rawTimes);
  return { posts, nextCursor };
}

// --- スレッド解決（docs/thread-view-spec.md §5、ADR-0014/0017） ---

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * NIP-10 に基づき、イベントの親（返信対象）のイベント id を定める。
 * - marker `reply` の e タグがあればそれを親とする。
 * - 無 marker の旧式イベントは位置で解釈する（e タグが1つだけならそれが親＝root への直接返信、
 *   複数なら最後が親）。marker `root` のみで多段のケースも最後尾ルールで親に当たる。
 * 親を定められない（e タグ無し）なら undefined（トップレベル投稿）。
 */
export function parentEventId(ev: NostrEvent): string | undefined {
  const eTags = ev.tags.filter((t) => t[0] === 'e' && typeof t[1] === 'string' && HEX64.test(t[1]));
  if (eTags.length === 0) return undefined;
  const reply = eTags.find((t) => t[3] === 'reply');
  if (reply) return reply[1];
  return eTags[eTags.length - 1][1];
}

const sortEventsAsc = (arr: NostrEvent[]): NostrEvent[] => arr.toSorted((a, b) => a.created_at - b.created_at);

/** 子孫イベント列から木を再構築し、DFS 順＋depth に平坦化する（worker/misskey の childrenToThreadNodes と同型） */
function buildReplyNodes(children: NostrEvent[], focusId: string, profiles: Map<string, NostrProfile>): ThreadNode[] {
  const byId = new Map(children.map((e) => [e.id, e]));
  const kidsOf = new Map<string, NostrEvent[]>();
  const orphans: NostrEvent[] = [];
  for (const e of children) {
    const parentId = parentEventId(e) ?? '';
    if (parentId === focusId || byId.has(parentId)) {
      const arr = kidsOf.get(parentId) ?? [];
      arr.push(e);
      kidsOf.set(parentId, arr);
    } else {
      orphans.push(e); // 親が取得集合に無い → 取得不能中間ノードを挿入して連続性を保つ
    }
  }
  const out: ThreadNode[] = [];
  const walk = (parentId: string, depth: number) => {
    for (const e of sortEventsAsc(kidsOf.get(parentId) ?? [])) {
      out.push({ post: buildPost(e, profiles.get(e.pubkey)), depth });
      walk(e.id, depth + 1);
    }
  };
  walk(focusId, 1);
  for (const e of sortEventsAsc(orphans)) {
    out.push({ unavailable: true, depth: 1 });
    out.push({ post: buildPost(e, profiles.get(e.pubkey)), depth: 2 });
    walk(e.id, 3);
  }
  return out;
}

/**
 * nostr スレッドのブラウザ直接解決（docs/thread-view-spec.md §5）。
 * フォーカス Post（source に生イベントを保持）を軸に、固定リレーセットへ照会して
 * 他 Provider と同じ ThreadResponse を組み立てる（ADR-0017: 契約の統一）。
 * - 子孫: `{ kinds:[1], '#e':[focusId] }`（1バッチ。ページング無し、nextCursor は常に null）。
 * - 祖先: NIP-10 の e タグ解釈で親を順に遡る（THREAD_ANCESTOR_LIMIT 段で打ち切り）。
 *   親がリレーから得られなかったらそこで打ち切り（ancestors は Post[] でプレースホルダを持たない）。
 * - 子孫の欠落親は unavailable ノードで表す（§8）。
 */
export async function getThread(focusPost: Post, opts: { wsFactory: WsFactory }): Promise<ThreadResponse> {
  const focusEv = focusPost.source as NostrEvent | undefined;
  if (!focusEv || typeof focusEv.id !== 'string' || !HEX64.test(focusEv.id)) {
    throw new NostrError(400, 'invalid focus event');
  }
  const urls = NOSTR_RELAYS;
  const factory = opts.wsFactory;

  // 子孫: `#e` 照会は直接参照しか返さないため、得られた子孫の id を frontier に BFS で拡張する。
  // 合計 THREAD_CHILDREN_LIMIT 件を1バッチの上限とする（ページング無し）。
  const children: NostrEvent[] = [];
  const seenChildren = new Set<string>();
  let frontier: string[] = [focusEv.id];
  while (frontier.length > 0 && children.length < THREAD_CHILDREN_LIMIT) {
    // 順次実行が意図: 次の frontier が確定しなければ照会できない（並列化不能）
    // eslint-disable-next-line no-await-in-loop
    const evs = await queryRelays(
      urls,
      { kinds: [1], '#e': frontier, limit: THREAD_CHILDREN_LIMIT },
      { wsFactory: factory },
    );
    frontier = [];
    for (const e of evs) {
      if (e.id === focusEv.id || seenChildren.has(e.id)) continue;
      if (children.length >= THREAD_CHILDREN_LIMIT) break; // 上限を厳守（バッチ単位のはみ出しを防ぐ）
      seenChildren.add(e.id);
      children.push(e);
      frontier.push(e.id);
    }
  }

  // 祖先を親連鎖で遡上（root までの最大 THREAD_ANCESTOR_LIMIT 段）
  const ancestorsEv: NostrEvent[] = [];
  const seen = new Set<string>([focusEv.id]);
  let cur = focusEv;
  while (ancestorsEv.length < THREAD_ANCESTOR_LIMIT) {
    const parentId = parentEventId(cur);
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    // 順次実行が意図: 親が確定しなければ次の親 id が決まらない（並列化不能）
    // eslint-disable-next-line no-await-in-loop
    const evs = await queryRelays(urls, { kinds: [1], ids: [parentId] }, { wsFactory: factory });
    const parent = evs.find((e) => e.id === parentId);
    if (!parent) break; // 取得不能 → 打ち切り
    ancestorsEv.push(parent);
    cur = parent;
  }
  ancestorsEv.reverse(); // root 先頭

  const pubkeys = new Set<string>([focusEv.pubkey]);
  for (const e of ancestorsEv) pubkeys.add(e.pubkey);
  for (const e of children) pubkeys.add(e.pubkey);
  const profiles = await loadProfiles([...pubkeys], urls, factory);

  return {
    focus: buildPost(focusEv, profiles.get(focusEv.pubkey)),
    ancestors: ancestorsEv.map((e) => buildPost(e, profiles.get(e.pubkey))),
    replies: buildReplyNodes(children, focusEv.id, profiles), // BFS が focus 自身を除外済み
    nextCursor: null,
  };
}
