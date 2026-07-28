/**
 * Misskey プロバイダ（raw fetch クライアント）。
 * API は `${instance}/api/*` への JSON POST（ボディの `i` で認証）。
 * mfm-js は MFM パース（本文のリッチ化）にのみ使用。
 */
import { parse, toString } from 'mfm-js';
import type {
  Author,
  DestinationOption,
  EmojiInfo,
  Media,
  Post,
  PostInputWire,
  Reaction,
  RichSegment,
  Source,
  SourceOption,
  TimelineResponse,
  Visibility,
} from '../../shared/types';

const DEFAULT_INSTANCE = 'https://misskey.io';
const LIMIT = 30;

export class MisskeyAuthError extends Error {}

/** Misskey API が返した業務エラー（ALREADY_REACTED 等）。code を保持し、BFF は 409 でクライアントへ転送する */
export class MisskeyApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface MisskeyEnv {
  MISSKEY_INSTANCE_URL?: string;
  MISSKEY_TOKEN?: string;
}

// --- Misskey API の最小型（使うフィールドのみ） ---
type MkUser = {
  id: string;
  username: string;
  name?: string | null;
  avatarUrl?: string | null;
  host?: string | null;
};
type MkFile = {
  id: string;
  url: string | null;
  thumbnailUrl?: string | null;
  comment?: string | null;
  type: string;
};
type MkNote = {
  id: string;
  createdAt: string;
  text?: string | null;
  cw?: string | null;
  user: MkUser;
  files?: MkFile[];
  replyId?: string | null;
  renoteId?: string | null;
  renote?: MkNote;
  visibility?: Visibility;
  localOnly?: boolean;
  repliesCount?: number;
  renoteCount?: number;
  reactions?: Record<string, number>;
  reactionEmojis?: Record<string, string>;
  emojis?: Record<string, string> | { name: string; url: string }[];
  myReaction?: string | null;
  channel?: { id: string; name: string } | null; // 所属チャンネル（使うのは id/name のみ）
};
type MfmNode = { type: string; props?: Record<string, unknown>; children?: MfmNode[] };

function instanceOf(env: MisskeyEnv): string {
  return (env.MISSKEY_INSTANCE_URL ?? DEFAULT_INSTANCE).replace(/\/+$/, '');
}

/** Misskey API を叩く。認証エラー（401/403）は status=401 に正規化して投げる */
async function mkApi<T>(env: MisskeyEnv, endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!env.MISSKEY_TOKEN) throw new MisskeyAuthError('missing-secrets');
  const res = await fetch(`${instanceOf(env)}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ i: env.MISSKEY_TOKEN, ...params }),
  });
  if (!res.ok) {
    const e = new Error(`misskey ${endpoint} ${res.status}`) as Error & { status?: number };
    e.status = res.status === 401 || res.status === 403 ? 401 : res.status;
    throw e;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// --- 絵文字 URL マップの正規化（object 配列両対応） ---
function emojiMap(e: MkNote['emojis']): Record<string, string> {
  if (!e) return {};
  if (Array.isArray(e)) {
    const m: Record<string, string> = {};
    for (const x of e) m[x.name] = x.url;
    return m;
  }
  return e;
}

// --- ローカルカスタム絵文字レジストリ（ADR-0006） ---
// Misskey の Note が返す reactionEmojis/emojis にはリモートカスタム絵文字しか載らないため、
// ローカル絵文字の URL はインスタンスの絵文字レジストリ POST /api/emojis（認証不要・全件返却）から解決する。

const EMOJI_TTL_MS = 30 * 60 * 1000;
type EmojiData = { map: Record<string, string>; list: EmojiInfo[] };
let emojiCache: { instance: string; at: number; data: EmojiData } | undefined;
const emojiInflight = new Map<string, Promise<EmojiData>>();

/**
 * インスタンスのローカルカスタム絵文字レジストリを取得する。
 * インメモリ TTL（30分）キャッシュ＋シングルフライト。初回のみ lazy 取得。
 * `map`（name → url）は pack 時の URL 解決に、`list`（compact な EmojiInfo[]）はピッカー配信に使う。
 * 取得失敗時は空データで縮退（絵文字はテキスト表示、タイムラインは続行＝非致命）。
 */
async function loadEmojiData(env: MisskeyEnv): Promise<EmojiData> {
  const instance = instanceOf(env);
  if (emojiCache && emojiCache.instance === instance && Date.now() - emojiCache.at < EMOJI_TTL_MS) {
    return emojiCache.data;
  }
  const inflight = emojiInflight.get(instance);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const res = await fetch(`${instance}/api/emojis`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) throw new Error(`misskey emojis ${res.status}`);
      const data = (await res.json()) as { emojis?: { name: string; url: string; aliases?: string[] }[] };
      const map: Record<string, string> = {};
      const list: EmojiInfo[] = [];
      for (const e of data.emojis ?? []) {
        map[e.name] = e.url;
        const info: EmojiInfo = { name: e.name, url: e.url };
        if (e.aliases && e.aliases.length > 0) info.aliases = e.aliases;
        list.push(info);
      }
      const result = { map, list };
      emojiCache = { instance, at: Date.now(), data: result };
      return result;
    } catch (err) {
      console.error('misskey emoji registry fetch failed', err);
      return { map: {}, list: [] };
    } finally {
      emojiInflight.delete(instance);
    }
  })();
  emojiInflight.set(instance, promise);
  return promise;
}

/** 絵文字レジストリの name → url マップ（pack 時の URL 解決用。ADR-0006） */
export async function loadEmojiRegistry(env: MisskeyEnv): Promise<Record<string, string>> {
  return (await loadEmojiData(env)).map;
}

/** 絵文字レジストリの compact な一覧（ピッカー配信用。生レジストリのフィールド過多を絞る） */
export async function getEmojiList(env: MisskeyEnv): Promise<EmojiInfo[]> {
  return (await loadEmojiData(env)).list;
}

/**
 * リアクションキーをローカルカスタム絵文字名へ正規化する。
 * - `:name:` → `name`
 * - `:name@.:` → `name`（ローカル明示表記）
 * - `:name@host:`（host≠`.`）→ null（リモート。同名別画像のローカル絵文字への誤解決を防ぐため対象外）
 * - Unicode 絵文字等 → null
 */
export function localEmojiName(key: string): string | null {
  if (!key.startsWith(':') || !key.endsWith(':') || key.length <= 2) return null;
  const inner = key.slice(1, -1);
  const at = inner.lastIndexOf('@');
  if (at < 0) return inner;
  if (inner.slice(at + 1) !== '.') return null;
  return inner.slice(0, at) || null;
}

// --- MFM → 統一 RichSegment（対応: text/link/mention/hashtag/emoji。装飾はプレーン縮退） ---
function plainOf(nodes: MfmNode[]): string {
  // mfm-js の toString は MfmNode[] を受ける（構造互換）
  return toString(nodes as never);
}

function mergeText(segs: RichSegment[]): RichSegment[] {
  const out: RichSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (s.type === 'text' && last?.type === 'text') last.text += s.text;
    else out.push(s);
  }
  return out;
}

export function mfmToRich(text: string, emojiUrls: Record<string, string>): { rich: RichSegment[]; plain: string } {
  const nodes = parse(text) as unknown as MfmNode[];
  const out: RichSegment[] = [];
  const walk = (ns: MfmNode[]) => {
    for (const n of ns) {
      switch (n.type) {
        case 'text':
          out.push({ type: 'text', text: (n.props?.text as string) ?? '' });
          break;
        case 'emojiCode': {
          const name = (n.props?.name as string) ?? '';
          out.push({ type: 'emoji', name, ...(emojiUrls[name] ? { url: emojiUrls[name] } : {}) });
          break;
        }
        case 'unicodeEmoji': {
          const ch = (n.props?.emoji as string) ?? '';
          out.push({ type: 'emoji', name: ch, char: ch });
          break;
        }
        case 'mention': {
          const acct = (n.props?.acct as string) || `@${(n.props?.username as string) ?? ''}`;
          out.push({ type: 'mention', handle: acct.replace(/^@/, '') });
          break;
        }
        case 'hashtag':
          out.push({ type: 'hashtag', tag: (n.props?.hashtag as string) ?? '' });
          break;
        case 'url':
          out.push({ type: 'link', url: (n.props?.url as string) ?? '' });
          break;
        case 'link':
          out.push({
            type: 'link',
            url: (n.props?.url as string) ?? '',
            text: n.children ? plainOf(n.children) : (n.props?.url as string),
          });
          break;
        case 'inlineCode':
        case 'mathInline':
        case 'blockCode':
        case 'mathBlock':
          out.push({ type: 'text', text: (n.props?.code as string) ?? '' });
          break;
        case 'search':
          out.push({ type: 'text', text: (n.props?.query as string) ?? '' });
          break;
        default:
          // bold/italic/strike/small/center/fn/quote 等は子を展開（装飾を落とす）
          if (n.children) walk(n.children);
          else if (typeof n.props?.text === 'string') out.push({ type: 'text', text: n.props.text });
      }
    }
  };
  walk(nodes);
  return { rich: mergeText(out), plain: plainOf(nodes) };
}

// --- ドメインモデルへのマッピング ---

const NAME_EMOJI_RE = /:([a-zA-Z0-9_]+):/g;

/**
 * 表示名中のカスタム絵文字ショートコード（`:name:`）をリッチセグメント化する
 * （docs/name-display-spec.md §4）。レジストリ未収録のショートコードは生テキストのまま。
 * ショートコードを1つも解決できない場合は undefined（プレーン描画にフォールバック）。
 */
export function nameToRich(name: string, registry: Record<string, string>): RichSegment[] | undefined {
  if (!name.includes(':')) return undefined;
  const segments: RichSegment[] = [];
  let last = 0;
  let resolved = false;
  NAME_EMOJI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAME_EMOJI_RE.exec(name))) {
    const url = registry[m[1]];
    if (!url) continue;
    resolved = true;
    if (m.index > last) segments.push({ type: 'text', text: name.slice(last, m.index) });
    segments.push({ type: 'emoji', name: m[1], url });
    last = m.index + m[0].length;
  }
  if (!resolved) return undefined;
  if (last < name.length) segments.push({ type: 'text', text: name.slice(last) });
  return segments;
}

function authorOf(u: MkUser, registry: Record<string, string> = {}): Author {
  const handle = u.host ? `${u.username}@${u.host}` : u.username;
  const displayName = u.name || u.username;
  const displayNameRich = nameToRich(displayName, registry);
  return {
    handle,
    displayName,
    ...(displayNameRich ? { displayNameRich } : {}),
    ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
  };
}

function mediaOf(files: MkFile[] | undefined): Media[] {
  if (!files) return [];
  return files
    .filter((f) => f.type.startsWith('image/'))
    .map((f) => ({ type: 'image' as const, url: f.url || f.thumbnailUrl || '', alt: f.comment || '' }));
}

function reactionsOf(note: MkNote, registry: Record<string, string>): { reactions?: Reaction[]; likes: number } {
  const r = note.reactions ?? {};
  const entries = Object.entries(r).filter(([, c]) => c > 0);
  const likes = entries.reduce((s, [, c]) => s + c, 0);
  if (entries.length === 0) return { likes };
  const emojis = note.reactionEmojis ?? {};
  const reactions: Reaction[] = entries
    .toSorted((a, b) => b[1] - a[1])
    .map(([key, count]) => {
      const custom = key.startsWith(':') && key.endsWith(':');
      const name = custom ? key.slice(1, -1) : key;
      const reaction: Reaction = { emoji: key, count };
      if (custom && emojis[name]) reaction.emojiUrl = emojis[name];
      else if (custom) {
        // reactionEmojis 未掲載（＝ローカルカスタム絵文字）はレジストリで補完（ADR-0006）
        const local = localEmojiName(key);
        if (local && registry[local]) reaction.emojiUrl = registry[local];
      }
      if (note.myReaction === key) reaction.me = true;
      return reaction;
    });
  return { reactions, likes };
}

/** ノート自身のフィールドを Post に映射する（renote/quote は扱わない） */
function basePost(note: MkNote, registry: Record<string, string>): Post {
  const text = note.text ?? '';
  // 本文絵文字: ノート由来（リモート）を優先し、ローカルはレジストリで補完（ADR-0006）
  const { rich, plain } = text ? mfmToRich(text, { ...registry, ...emojiMap(note.emojis) }) : { rich: undefined, plain: '' };
  const { reactions, likes } = reactionsOf(note, registry);
  const post: Post = {
    id: note.id,
    provider: 'misskey',
    author: authorOf(note.user, registry),
    text: plain,
    createdAt: note.createdAt,
    media: mediaOf(note.files),
    stats: { replies: note.repliesCount ?? 0, reposts: note.renoteCount ?? 0, likes },
    ref: note.id,
    source: note,
  };
  if (rich && rich.length > 0) post.rich = rich;
  if (reactions) post.reactions = reactions;
  if (note.visibility && note.visibility !== 'public') post.visibility = note.visibility;
  if (note.localOnly) post.localOnly = true;
  if (note.channel) post.channel = { id: note.channel.id, name: note.channel.name };
  return post;
}

function isPureRenote(note: MkNote): boolean {
  return Boolean(note.renote) && !note.text && (!note.files || note.files.length === 0);
}

/**
 * ノートを Post に映射する（renote/quote を処理）。
 * - 純粋renote: 内包ノートを表示主体にし、repostedBy に renote した人を載せる（id は renote 活動、ref は元ノート）。
 * - 引用renote: 本文＋ quote（1階層のみ）。
 */
export function mapNote(note: MkNote, registry: Record<string, string> = {}): Post {
  if (isPureRenote(note) && note.renote) {
    const inner = basePost(note.renote, registry);
    const post: Post = {
      ...inner,
      id: note.id, // renote 活動ごとに一意（dedup されすぎない）
      createdAt: note.createdAt, // フィードに現れた時刻（マージ順序の歪みを避ける）
      repostedBy: authorOf(note.user, registry),
      source: note,
    };
    // チャンネルは外側（renote 活動）優先、無ければ内側（コンテンツの出身）。
    // 「なぜこの投稿が TL に現れたか」を説明するため（docs/misskey-channel-display-spec.md）。
    if (note.channel) post.channel = { id: note.channel.id, name: note.channel.name };
    return post;
  }
  const post = basePost(note, registry);
  if (note.renote && !isPureRenote(note)) {
    // 本文付き引用、またはテキスト無しでもメディア付きの引用を拾う（1階層、ネスト引用は落とす）
    post.quote = basePost(note.renote, registry);
  }
  return post;
}

// --- BFF 処理本体 ---

/**
 * Source 種別（home / list / antenna / channel）を Misskey のタイムライン API へ dispatch する。
 * list = notes/user-list-timeline (listId)、antenna = antennas/notes (antennaId)、
 * channel = channels/timeline (channelId)（docs/misskey-channel-source-spec.md）。
 * ページングは共通で untilId（Source 種別に依存しない）。
 */
export async function getTimeline(env: MisskeyEnv, source: Source, cursor?: string): Promise<TimelineResponse> {
  const params: Record<string, unknown> = { limit: LIMIT };
  if (cursor) params.untilId = cursor;
  let endpoint = 'notes/timeline';
  if (source.kind === 'list') {
    if (!source.id) throw new MisskeyApiError(400, 'list source requires id');
    endpoint = 'notes/user-list-timeline';
    params.listId = source.id;
  } else if (source.kind === 'antenna') {
    if (!source.id) throw new MisskeyApiError(400, 'antenna source requires id');
    endpoint = 'antennas/notes';
    params.antennaId = source.id;
  } else if (source.kind === 'channel') {
    if (!source.id) throw new MisskeyApiError(400, 'channel source requires id');
    endpoint = 'channels/timeline';
    params.channelId = source.id;
  }
  const notes = await mkApi<MkNote[]>(env, endpoint, params);
  const registry = await loadEmojiRegistry(env);
  const posts = notes.map((n) => mapNote(n, registry));
  return { posts, nextCursor: notes.length > 0 ? notes[notes.length - 1].id : null };
}

/**
 * ピッカー用の選択可能 Source 一覧（ホーム + ユーザーリスト + アンテナ + お気に入りチャンネル）。
 * users/lists/list・antennas/list・channels/my-favorites を並列取得し、人間可読名を添えて返す。
 * チャンネル候補はフォロー中ではなくお気に入り（docs/misskey-channel-source-spec.md）。
 * ラベルの 📺 プレフィックスは PostCard チップと同一の視覚言語。
 */
export async function listSources(env: MisskeyEnv): Promise<SourceOption[]> {
  const options: SourceOption[] = [{ source: { provider: 'misskey', kind: 'home' }, name: 'ホーム' }];
  const [lists, antennas, favorites] = await Promise.all([
    mkApi<{ id: string; name: string }[]>(env, 'users/lists/list'),
    mkApi<{ id: string; name: string }[]>(env, 'antennas/list'),
    mkApi<{ id: string; name: string }[]>(env, 'channels/my-favorites', { limit: 100 }),
  ]);
  for (const l of lists) options.push({ source: { provider: 'misskey', kind: 'list', id: l.id }, name: l.name });
  for (const a of antennas) options.push({ source: { provider: 'misskey', kind: 'antenna', id: a.id }, name: a.name });
  for (const c of favorites ?? []) options.push({ source: { provider: 'misskey', kind: 'channel', id: c.id }, name: `📺 ${c.name}` });
  return options;
}

/**
 * Compose 用の投稿先（Destination）一覧（ホーム + チャンネル）。
 * チャンネル候補は channels/followed（フォロー中）∪ channels/my-favorites（お気に入り）を id で重複排除。
 * 閲覧カタログ（listSources）がお気に入りのみなのに対し、投稿先はフォロー中を本命とする意図的な差異
 * （docs/compose-destination-spec.md §4.1）。
 */
export async function listDestinations(env: MisskeyEnv): Promise<DestinationOption[]> {
  const options: DestinationOption[] = [{ destination: { provider: 'misskey', kind: 'home' }, name: 'ホーム' }];
  const [followed, favorites] = await Promise.all([
    mkApi<{ id: string; name: string }[]>(env, 'channels/followed', { limit: 100 }),
    mkApi<{ id: string; name: string }[]>(env, 'channels/my-favorites', { limit: 100 }),
  ]);
  const seen = new Set<string>();
  for (const c of [...(followed ?? []), ...(favorites ?? [])]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    options.push({ destination: { provider: 'misskey', kind: 'channel', id: c.id }, name: `📺 ${c.name}` });
  }
  return options;
}

/** 画像をドライブへアップロードし、fileId を opaque 参照として返す */
export async function uploadMedia(
  env: MisskeyEnv,
  bytes: ArrayBuffer,
  mimeType: string,
  alt: string,
): Promise<unknown> {
  if (!env.MISSKEY_TOKEN) throw new MisskeyAuthError('missing-secrets');
  const fd = new FormData();
  fd.append('i', env.MISSKEY_TOKEN);
  fd.append('file', new File([bytes], `upload.${mimeType.split('/')[1] || 'png'}`, { type: mimeType }));
  if (alt) fd.append('comment', alt);
  const res = await fetch(`${instanceOf(env)}/api/drive/files/create`, { method: 'POST', body: fd });
  if (!res.ok) {
    const e = new Error(`misskey drive ${res.status}`) as Error & { status?: number };
    e.status = res.status === 401 || res.status === 403 ? 401 : res.status;
    throw e;
  }
  const file = (await res.json()) as { id: string };
  return file.id;
}

/** 投稿を作成し、統合 Post として返す */
export async function createPost(env: MisskeyEnv, input: PostInputWire): Promise<Post> {
  const params: Record<string, unknown> = {};
  if (input.text.length > 0) params.text = input.text;
  if (input.contentWarning) params.cw = input.contentWarning;
  params.visibility = input.visibility ?? 'public';
  if (input.localOnly) params.localOnly = true;
  const fileIds = (input.images ?? []).map((i) => i.blob as string).filter(Boolean);
  if (fileIds.length > 0) params.fileIds = fileIds;
  if (input.replyTo) params.replyId = input.replyTo as string;
  if (input.quote) params.renoteId = input.quote as string; // 引用 = 本文付き renote
  // チャンネル投稿（docs/compose-destination-spec.md §4.2）。visibility/localOnly はサーバが public/true に強制するため送信値は意味を持たない
  if (input.destination?.kind === 'channel') params.channelId = input.destination.id;
  const res = await mkApi<{ createdNote: MkNote }>(env, 'notes/create', params);
  const registry = await loadEmojiRegistry(env);
  return mapNote(res.createdNote, registry);
}

// --- リアクション操作（docs/misskey-reaction-action-spec.md） ---

/**
 * ノートへリアクションを付与/置換（reaction あり）または解除（reaction なし）。
 * Misskey は1ユーザー1反応で、別絵文字の create はサーバ側で置換される（delete→create 不要）。
 * 業務エラー（ALREADY_REACTED 等）は MisskeyApiError(409, code)、認証エラーは status=401 に正規化する。
 */
export async function react(env: MisskeyEnv, noteId: string, reaction?: string): Promise<void> {
  if (!env.MISSKEY_TOKEN) throw new MisskeyAuthError('missing-secrets');
  const endpoint = reaction ? 'notes/reactions/create' : 'notes/reactions/delete';
  const params: Record<string, unknown> = { noteId };
  if (reaction) params.reaction = reaction;
  const res = await fetch(`${instanceOf(env)}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ i: env.MISSKEY_TOKEN, ...params }),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`misskey ${endpoint} ${res.status}`) as Error & { status?: number };
      e.status = 401;
      throw e;
    }
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: string } };
      code = body?.error?.code;
    } catch {
      /* ignore */
    }
    // Misskey の業務エラー（code 付き）→ 409。code 無し（5xx 等のシステム障害）は
    // 素の Error のまま投げ、run() の catch-all で 502 にする（409 で隠蔽しない）。
    if (code) throw new MisskeyApiError(409, `misskey ${endpoint} ${res.status}`, code);
    throw new Error(`misskey ${endpoint} ${res.status}`);
  }
}

// --- リノート操作（docs/deck-view-spec.md §6。v1 は作成のみ・解除は未対応） ---

/** ノートを本文無しでリノートする。二重リノート等の業務エラーは mkApi 経由で status 付き Error → run() が 502 転送（v1 はコード抽出しない） */
export async function renote(env: MisskeyEnv, noteId: string): Promise<void> {
  await mkApi<{ createdNote: MkNote }>(env, 'notes/create', { renoteId: noteId, visibility: 'public' });
}

// --- インスタンス設定（compose の文字上限） ---
let metaCache: { instance: string; charLimit: number } | undefined;

/** maxNoteTextLength を取得（インスタンス URL 単位でキャッシュ）。未取得/失敗時は 3000 にフォールバック */
export async function getComposeCharLimit(env: MisskeyEnv): Promise<number> {
  const instance = instanceOf(env);
  if (metaCache && metaCache.instance === instance) return metaCache.charLimit;
  try {
    const meta = await mkApi<{ maxNoteTextLength?: number }>(env, 'meta', { detail: false });
    const charLimit = meta?.maxNoteTextLength ?? 3000;
    metaCache = { instance, charLimit };
    return charLimit;
  } catch {
    return 3000;
  }
}
