/**
 * Nostr 読み取り専用 Provider（docs/nostr-integration-spec.md、ADR-0013）。
 *
 * - BFF がリレー群へリクエスト単位で WebSocket を開き（§6.2）、NIP-01 REQ でイベントを収集する。
 * - 収集したイベントは id で重複排除し、schnorr 署名＋ id 再計算で全件検証する（§6.2 ステップ4-5）。
 * - kind 1 を Post に、kind 6 を repostedBy として包む（§6.5）。kind 0 で Author を解決する（§6.4）。
 * - 鍵（nsec）は一切扱わない。閲覧は署名不要。
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32 } from '@scure/base';
import type { Author, Media, Post, RichSegment, Source, TimelineResponse } from '../../shared/types';

// --- 定数（§6.1 固定リレーセット / §6.2 収集ウィンドウ） ---
export const NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.hiroba.media',
];
const COLLECT_TIMEOUT_MS = 4000;
const PAGE_SIZE = 30;
const FETCH_LIMIT = PAGE_SIZE * 3; // 重複排除・kind6解決後の欠損を見込んだ余裕
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
};

type Profile = { displayName?: string; picture?: string };

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

const defaultWsFactory: WsFactory = async (url) => {
  const resp = await fetch(url, { headers: { Upgrade: 'websocket' } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`relay did not upgrade: ${url}`);
  ws.accept();
  return ws as unknown as WsLike;
};

/**
 * 複数リレーへ並列に REQ を投げ、EOSE またはタイムアウトまで収集して閉じる（§6.2）。
 * 到達不能リレーは黙ってスキップ、id で重複排除、署名検証済みのイベントだけを返す。
 */
export async function queryRelays(
  urls: string[],
  filter: NostrFilter,
  opts?: { timeoutMs?: number; wsFactory?: WsFactory },
): Promise<NostrEvent[]> {
  const timeoutMs = opts?.timeoutMs ?? COLLECT_TIMEOUT_MS;
  const factory = opts?.wsFactory ?? defaultWsFactory;
  const sink = new Map<string, NostrEvent>();
  await Promise.allSettled(urls.map((u) => queryOne(u, filter, factory, sink, timeoutMs)));
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
): Promise<void> {
  return factory(url)
    .catch(() => undefined)
    .then(
      (ws) =>
        new Promise<void>((resolve) => {
          if (!ws) {
            resolve();
            return;
          }
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
const profileCache = new Map<string, { at: number; profile: Profile }>();
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

export function parseProfile(content?: string): Profile {
  if (!content) return {};
  try {
    const j = JSON.parse(content) as { display_name?: string; name?: string; picture?: string };
    const p: Profile = {};
    const dn = j.display_name || j.name;
    if (typeof dn === 'string' && dn.length > 0) p.displayName = dn;
    if (typeof j.picture === 'string' && j.picture.length > 0) p.picture = j.picture;
    return p;
  } catch {
    return {};
  }
}

async function loadProfiles(
  pubkeys: string[],
  urls: string[],
  factory?: WsFactory,
): Promise<Map<string, Profile>> {
  sweepExpiredProfiles(Date.now());
  const result = new Map<string, Profile>();
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
      if (IMAGE_EXT.test(tok)) {
        media.push({ type: 'image', url: tok }); // 本文からは除去（§5.2）
      } else {
        rich.push({ type: 'link', url: tok });
        plain += tok;
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
function toAuthor(pubkeyHex: string, profile?: Profile): Author {
  const handle = shortenNpub(pubkeyHex);
  const a: Author = { handle, displayName: profile?.displayName || handle };
  if (profile?.picture) a.avatarUrl = profile.picture;
  return a;
}

function buildPost(ev: NostrEvent, profile: Profile | undefined, repostedBy?: Author): Post {
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
  opts?: { wsFactory?: WsFactory },
): Promise<TimelineResponse> {
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

  const events = await queryRelays(urls, filter, { wsFactory: opts?.wsFactory });
  const kind1 = events.filter((e) => e.kind === 1);
  const kind6 = events.filter((e) => e.kind === 6);

  // kind 6 の参照先（元ノート）を ids でバッチ取得（§6.5）
  const refs = [...new Set(kind6.map(eTagId).filter((x): x is string => Boolean(x)))];
  const originals = new Map<string, NostrEvent>();
  if (refs.length > 0) {
    for (const ev of await queryRelays(urls, { kinds: [1], ids: refs }, { wsFactory: opts?.wsFactory })) {
      originals.set(ev.id, ev);
    }
  }

  // 登場する全 pubkey のプロフィールをまとめて解決（§6.4）
  const pubkeys = new Set<string>();
  for (const e of kind1) pubkeys.add(e.pubkey);
  for (const e of kind6) pubkeys.add(e.pubkey);
  for (const e of originals.values()) pubkeys.add(e.pubkey);
  const profiles = await loadProfiles([...pubkeys], urls, opts?.wsFactory);

  const posts: Post[] = [];
  for (const e of kind1) posts.push(buildPost(e, profiles.get(e.pubkey)));
  for (const e of kind6) {
    const orig = originals.get(eTagId(e) ?? '');
    if (!orig) continue; // 参照先未取得のリポストはスキップ（§6.5）
    posts.push(buildPost(orig, profiles.get(orig.pubkey), toAuthor(e.pubkey, profiles.get(e.pubkey))));
  }

  posts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const page = posts.slice(0, PAGE_SIZE);
  const nextCursor =
    page.length > 0 ? String(Math.floor(Date.parse(page[page.length - 1].createdAt) / 1000)) : null;
  return { posts: page, nextCursor };
}
