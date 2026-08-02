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
  Notification,
  NotificationType,
  NotificationsResponse,
  Post,
  PostInputWire,
  Profile,
  Reaction,
  RichSegment,
  Source,
  SourceOption,
  ThreadNode,
  ThreadResponse,
  TimelineResponse,
  Visibility,
} from '../../shared/types';

const DEFAULT_INSTANCE = 'https://misskey.io';
const LIMIT = 30;
/** 祖先の遡上上限（bsky parentHeight / nostr THREAD_ANCESTOR_LIMIT と同値。docs/thread-view-spec.md §4/§5） */
const ANCESTOR_LIMIT = 25;

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
  description?: string | null;
  bannerUrl?: string | null;
  notesCount?: number;
  followingCount?: number;
  followersCount?: number;
  isFollowing?: boolean;
  emojis?: Record<string, string> | { name: string; url: string }[]; // 名前・自己紹介のカスタム絵文字
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

/** i/notifications の1通知（使うフィールドのみ） */
type MkNotification = {
  id: string;
  createdAt: string;
  type: string;
  isRead?: boolean;
  user?: MkUser | null;
  note?: MkNote | null;
  reaction?: string | null;
  body?: string | null; // app 通知の本文
  achievement?: { name?: string } | null;
};

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
    id: u.id,
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
function basePost(note: MkNote, registry: Record<string, string>, instanceUrl?: string): Post {
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
  if (note.cw) post.cw = note.cw; // 空文字は設定しない（docs/cw-display-spec.md）
  if (instanceUrl) post.url = `${instanceUrl}/notes/${note.id}`; // permalink（docs/quote-display-spec.md）
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
export function mapNote(note: MkNote, registry: Record<string, string> = {}, instanceUrl?: string): Post {
  if (isPureRenote(note) && note.renote) {
    const inner = basePost(note.renote, registry, instanceUrl);
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
  const post = basePost(note, registry, instanceUrl);
  if (note.renote && !isPureRenote(note)) {
    // 本文付き引用、またはテキスト無しでもメディア付きの引用を拾う（1階層、ネスト引用は落とす）
    post.quote = basePost(note.renote, registry, instanceUrl);
  }
  return post;
}

// --- 通知（docs/notifications-spec.md、ADR-0019） ---

/** Misskey の通知 type を統一 NotificationType へ写像する（未知 type は生のまま。UI はフィールドの有無で描画を決める） */
export function misskeyTypeToType(type: string): NotificationType {
  switch (type) {
    case 'follow':
    case 'mention':
    case 'reply':
    case 'renote':
    case 'quote':
    case 'reaction':
    case 'pollVote':
    case 'pollEnded':
    case 'note':
    case 'app':
    case 'receiveFollowRequest':
    case 'followRequestAccepted':
    case 'achievementEarned':
    case 'roleAssigned':
    case 'chatRoomInvitationReceived':
    case 'exportCompleted':
    case 'login':
    case 'createToken':
    case 'test':
    case 'scheduledNotePosted':
    case 'scheduledNotePostFailed':
      return type;
    default:
      return type as NotificationType;
  }
}

/** テキストのみの通知の表示文（BFF が合成。docs/notifications-spec.md §6） */
export function misskeyNotificationText(type: NotificationType, n?: MkNotification): string | undefined {
  switch (type) {
    case 'achievementEarned':
      return n?.achievement?.name
        ? `実績「${n.achievement.name}」を獲得しました`
        : '実績を獲得しました';
    case 'login':
      return '新しいデバイスからログインしました';
    case 'createToken':
      return 'API トークンが作成されました';
    case 'test':
      return 'テスト通知';
    case 'exportCompleted':
      return 'エクスポートが完了しました';
    case 'roleAssigned':
      return 'ロールが付与されました';
    case 'chatRoomInvitationReceived':
      return 'チャットルームに招待されました';
    case 'scheduledNotePosted':
      return '予約したノートが投稿されました';
    case 'scheduledNotePostFailed':
      return '予約したノートの投稿に失敗しました';
    case 'pollEnded':
      return 'あなたのアンケートが終了しました';
    case 'app':
      return n?.body ?? undefined;
    default:
      return undefined;
  }
}

/** i/notifications の1通知を統一 Notification に写像する純粋関数（ADR-0019） */
export function mapMisskeyNotification(
  n: MkNotification,
  registry: Record<string, string> = {},
  instanceUrl?: string,
): Notification {
  const type = misskeyTypeToType(n.type);
  const notif: Notification = {
    id: n.id,
    provider: 'misskey',
    type,
    createdAt: n.createdAt,
    isRead: n.isRead ?? false,
  };
  if (n.user) notif.actor = authorOf(n.user, registry);
  if (n.note) notif.post = mapNote(n.note, registry, instanceUrl);
  if (n.reaction) notif.reaction = n.reaction;
  const text = misskeyNotificationText(type, n);
  if (text) notif.text = text;
  return notif;
}

/**
 * 通知一覧（docs/notifications-spec.md §4.1）。markAsRead: false を明示（デフォルト true のため、
 * ポーリングだけで全既読になるのを防ぐ。既読化は POST /api/notifications/read に閉じる）。
 * 未読数は i の unreadNotificationsCount（旧バージョンは unreadNotifications）。
 */
export async function getNotifications(env: MisskeyEnv, cursor?: string): Promise<NotificationsResponse> {
  const params: Record<string, unknown> = { limit: LIMIT, markAsRead: false };
  if (cursor) params.untilId = cursor;
  const [list, me] = await Promise.all([
    mkApi<MkNotification[]>(env, 'i/notifications', params),
    mkApi<{ unreadNotificationsCount?: number; unreadNotifications?: number }>(env, 'i'),
  ]);
  const registry = await loadEmojiRegistry(env);
  const inst = instanceOf(env);
  const items = list ?? [];
  const last = items[items.length - 1];
  return {
    notifications: items.map((n) => mapMisskeyNotification(n, registry, inst)),
    unreadCount: me?.unreadNotificationsCount ?? me?.unreadNotifications ?? 0,
    nextCursor: items.length >= LIMIT && last ? last.id : null,
  };
}

/** 通知の全既読（markAsRead: true で取得。サーバー側で readAllNotification が走る。docs/notifications-spec.md §4.2） */
export async function markNotificationsRead(env: MisskeyEnv): Promise<void> {
  await mkApi(env, 'i/notifications', { limit: 1, markAsRead: true });
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
  const posts = notes.map((n) => mapNote(n, registry, instanceOf(env)));
  return { posts, nextCursor: notes.length > 0 ? notes[notes.length - 1].id : null };
}

const sortNotesAsc = (arr: MkNote[]): MkNote[] => arr.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

/**
 * notes/children の平坦なリプライ列から木を再構築し、DFS 順＋depth に平坦化する純粋関数
 * （docs/thread-view-spec.md §4.3、ADR-0017）。replyId で親子関係を組み、時系列昇順で DFS する。
 * 親が取得集合に無い（focus 直下でもない）ノードは、取得不能の中間ノードを unavailable で挿入して連続性を保つ。
 */
export function childrenToThreadNodes(
  children: MkNote[],
  focusId: string,
  registry: Record<string, string> = {},
  instanceUrl?: string,
  opts?: { continuation?: boolean },
): ThreadNode[] {
  const byId = new Map(children.map((n) => [n.id, n]));
  const kidsOf = new Map<string, MkNote[]>();
  const orphans: MkNote[] = [];
  for (const n of children) {
    const parentId = n.replyId ?? '';
    if (parentId === focusId || byId.has(parentId)) {
      const arr = kidsOf.get(parentId) ?? [];
      arr.push(n);
      kidsOf.set(parentId, arr);
    } else {
      orphans.push(n);
    }
  }
  const out: ThreadNode[] = [];
  const walk = (parentId: string, depth: number) => {
    for (const n of sortNotesAsc(kidsOf.get(parentId) ?? [])) {
      out.push({ post: mapNote(n, registry, instanceUrl), depth });
      walk(n.id, depth + 1);
    }
  };
  walk(focusId, 1);
  // 孤児ノード: 欠落親ごとにグループ化し、プレースホルダは1グループ1つ（同じ欠落親への複数返信で案内行が重複しないよう）
  const orphanGroups = new Map<string, MkNote[]>();
  for (const n of orphans) {
    const key = n.replyId ?? '';
    const arr = orphanGroups.get(key) ?? [];
    arr.push(n);
    orphanGroups.set(key, arr);
  }
  for (const group of orphanGroups.values()) {
    // continuation（cursor 付き追加ページ）: 親は前のページに描画済みなのでプレースホルダを出さず depth 1 に継ぐ
    const base = opts?.continuation ? 0 : 1;
    if (!opts?.continuation) out.push({ unavailable: true, depth: 1 });
    for (const n of sortNotesAsc(group)) {
      out.push({ post: mapNote(n, registry, instanceUrl), depth: base + 1 });
      walk(n.id, base + 2);
    }
  }
  return out;
}

/**
 * スレッド取得（docs/thread-view-spec.md §4.3）。notes/show（フォーカス）+ notes/conversation（祖先）+
 * notes/children（子孫）を組み合わせ、ThreadResponse を組み立てる。
 * 祖先は notes/conversation の返り順（親→root）を反転して root 先頭にする。
 * 子孫の追加ページングは notes/children の untilId（cursor エコー）。focus 取得不能（404）は呼び出し側へそのまま投げる。
 */
export async function getThread(env: MisskeyEnv, noteId: string, cursor?: string): Promise<ThreadResponse> {
  const registry = await loadEmojiRegistry(env);
  const inst = instanceOf(env);
  const childrenParams: Record<string, unknown> = { noteId, limit: LIMIT };
  if (cursor) childrenParams.untilId = cursor;
  // フォーカスを先に取得する: 404 を「focus 取得不能」として明確にするため
  // （conversation/children と並列にすると、部分失敗の 404 が focus 由来と区別できなくなる）
  const focus = await mkApi<MkNote>(env, 'notes/show', { noteId });
  const [conversation, children] = await Promise.all([
    mkApi<MkNote[]>(env, 'notes/conversation', { noteId, limit: ANCESTOR_LIMIT }),
    mkApi<MkNote[]>(env, 'notes/children', childrenParams),
  ]);
  const ancestors = (conversation ?? []).toReversed().map((n) => mapNote(n, registry, inst));
  const kids = children ?? [];
  const replies = childrenToThreadNodes(kids, noteId, registry, inst, { continuation: Boolean(cursor) });
  const last = kids[kids.length - 1];
  const nextCursor = kids.length >= LIMIT && last ? last.id : null;
  return { focus: mapNote(focus, registry, inst), ancestors, replies, nextCursor };
}

/** レスポンスボディから Misskey の業務エラー情報を抽出する（code / kind。JSON でなければ undefined） */
async function readMisskeyError(res: Response): Promise<{ code?: string; kind?: string } | undefined> {
  try {
    const body = (await res.json()) as { error?: { code?: string; kind?: string } };
    return body?.error ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 業務エラーコードを抽出する API 呼び出し（follow/unfollow 用）。
 * 認証失敗（401、または 403 + kind: 'authentication' / AUTHENTICATION_FAILED 等）は status=401、
 * それ以外の code 付き業務エラー（YOU_ARE_BLOCKED / NO_SUCH_USER / NOT_FOLLOWING 等）は
 * MisskeyApiError(409) に正規化する（react と同じ流儀。mkApi は code を抽出しないため、
 * 業務エラーが 502 に化けるのを防ぐ）。
 */
async function mkApiWithCode<T>(
  env: MisskeyEnv,
  endpoint: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!env.MISSKEY_TOKEN) throw new MisskeyAuthError('missing-secrets');
  const res = await fetch(`${instanceOf(env)}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ i: env.MISSKEY_TOKEN, ...params }),
  });
  if (!res.ok) {
    const err = await readMisskeyError(res);
    if (res.status === 401 || res.status === 403) {
      // 認証失敗（HTTP 401 は常に認証、403 は kind: 'authentication' または認証系 code）のみ 401 にし、
      // 業務 code（YOU_ARE_BLOCKED 等、403 に載る）は 409 にする。code も kind も無い素の 401/403（WAF 等）は
      // 素の Error のまま投げ、catch-all で 502 にする（恒久認証失敗に誤分類しない）
      const isAuth =
        res.status === 401 ||
        err?.kind === 'authentication' ||
        /AUTHENTICATION_FAILED|PERMISSION_DENIED/i.test(err?.code ?? '');
      if (err?.code && !isAuth) throw new MisskeyApiError(409, `misskey ${endpoint} ${res.status}`, err.code);
      if (isAuth) {
        const e = new Error(`misskey ${endpoint} ${res.status}`) as Error & { status?: number };
        e.status = 401;
        throw e;
      }
      throw new Error(`misskey ${endpoint} ${res.status}`);
    }
    if (err?.code) throw new MisskeyApiError(409, `misskey ${endpoint} ${res.status}`, err.code);
    throw new Error(`misskey ${endpoint} ${res.status}`);
  }
  const text = await res.text();
  if (!text) return null as T; // 空ボディ（2xx で中身なし）は null に縮退
  try {
    return JSON.parse(text) as T;
  } catch {
    // 2xx なのに JSON でない応答（リバースプロキシ/WAF の HTML 等）は上流異常として投げる
    // （null-as-success で未実行の操作を成功表示しない。mkApi と同じく 502 になる）
    throw new Error(`misskey ${endpoint} invalid json`);
  }
}

// --- プロフィール（docs/profile-view-spec.md §4/§5/§6） ---

/** ユーザーのプロフィール permalink（ローカルはインスタンス、リモートはホームインスタンスのユーザーページ） */
function userUrl(u: MkUser, instanceUrl?: string): string | undefined {
  if (!instanceUrl) return undefined;
  return u.host ? `https://${u.host}/@${u.username}` : `${instanceUrl}/@${u.username}`;
}

/** users/show の応答（MkUser）を統一 Profile へ映射する純粋関数 */
export function mapProfile(
  u: MkUser,
  registry: Record<string, string> = {},
  instanceUrl?: string,
): Profile {
  // 表示名・自己紹介の絵文字はユーザー由来（リモート）を優先しローカルはレジストリで補完（ADR-0006 の流儀）
  const emojiUrls = { ...registry, ...emojiMap(u.emojis) };
  const profile: Profile = {
    provider: 'misskey',
    author: authorOf(u, emojiUrls),
  };
  if (u.description) {
    // 自己紹介: plain（フォールバック/検索用）と rich（表示用）。合成マップは authorOf と共有する
    const { rich, plain } = mfmToRich(u.description, emojiUrls);
    profile.description = plain;
    if (rich.length > 0) profile.descriptionRich = rich;
  }
  if (u.bannerUrl) profile.bannerUrl = u.bannerUrl;
  if (u.notesCount !== undefined && u.followingCount !== undefined && u.followersCount !== undefined) {
    profile.stats = {
      posts: u.notesCount,
      following: u.followingCount,
      followers: u.followersCount,
    };
  }
  if (u.isFollowing !== undefined) profile.viewer = { following: u.isFollowing };
  const url = userUrl(u, instanceUrl);
  if (url) profile.url = url;
  return profile;
}

/** プロフィール概要の取得（docs/profile-view-spec.md §4.3）。id は userId（Author.id）
 * mkApiWithCode 経由で NO_SUCH_USER（HTTP 400 + code）を MisskeyApiError として拾い、
 * ルートの isMisskeyNotFound → 404 に載せる（mkApi だと status 400 の素エラーになり 502 に化けるため）。 */
export async function getProfile(env: MisskeyEnv, userId: string): Promise<Profile> {
  const [user, registry] = await Promise.all([
    mkApiWithCode<MkUser>(env, 'users/show', { userId }),
    loadEmojiRegistry(env),
  ]);
  if (!user) throw new Error('misskey users/show returned empty');
  return mapProfile(user, registry, instanceOf(env));
}

/**
 * プロフィールの投稿一覧（docs/profile-view-spec.md §5.2）。users/notes の既定で
 * リノート含む（withRenotes=true）・リプライ含まず（withReplies=false）。untilId ページング。
 */
export async function getProfilePosts(
  env: MisskeyEnv,
  userId: string,
  cursor?: string,
): Promise<TimelineResponse> {
  // users/notes の既定（withRenotes=true・withReplies=false）に依存せず明示する（bsky の filter と同様に意図を固定）
  const params: Record<string, unknown> = { userId, limit: LIMIT, withRenotes: true, withReplies: false };
  if (cursor) params.untilId = cursor;
  // users/notes と絵文字レジストリは独立したネットワーク呼び出しのため並列化する（getProfile と同じ）
  const [rawNotes, registry] = await Promise.all([
    mkApiWithCode<MkNote[]>(env, 'users/notes', params),
    loadEmojiRegistry(env),
  ]);
  const notes = rawNotes ?? [];
  const inst = instanceOf(env);
  const posts = notes.map((n) => mapNote(n, registry, inst));
  const last = notes[notes.length - 1];
  return { posts, nextCursor: notes.length >= LIMIT && last ? last.id : null };
}

/** フォローする（following/create。docs/profile-view-spec.md §6） */
export async function followUser(env: MisskeyEnv, userId: string): Promise<void> {
  await mkApiWithCode(env, 'following/create', { userId });
}

/** フォローを解除する（following/delete） */
export async function unfollowUser(env: MisskeyEnv, userId: string): Promise<void> {
  await mkApiWithCode(env, 'following/delete', { userId });
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
  return mapNote(res.createdNote, registry, instanceOf(env));
}

// --- リアクション操作（docs/misskey-reaction-action-spec.md） ---

/**
 * ノートへリアクションを付与/置換（reaction あり）または解除（reaction なし）。
 * Misskey は1ユーザー1反応で、別絵文字の create はサーバ側で置換される（delete→create 不要）。
 * 業務エラー（ALREADY_REACTED 等）は MisskeyApiError(409, code)、認証エラーは status=401 に正規化する。
 */
export async function react(env: MisskeyEnv, noteId: string, reaction?: string): Promise<void> {
  const endpoint = reaction ? 'notes/reactions/create' : 'notes/reactions/delete';
  const params: Record<string, unknown> = { noteId };
  if (reaction) params.reaction = reaction;
  // mkApiWithCode が認証エラー（401）・業務エラー（409, code）の正規化を担う（エラー契約の一元化）
  await mkApiWithCode(env, endpoint, params);
}

// --- リノート操作（docs/deck-view-spec.md §6。v1 は作成のみ・解除は未対応） ---

/** ノートを本文無しでリノートする。二重リノート等の業務エラーは mkApi 経由で status 付き Error → run() が 502 転送（v1 はコード抽出しない） */
export async function renote(env: MisskeyEnv, noteId: string): Promise<void> {
  await mkApi<{ createdNote: MkNote }>(env, 'notes/create', { renoteId: noteId, visibility: 'public' });
}

// --- ブロック・ミュート操作（docs/block-mute-spec.md。userId は Author.id） ---

/** ユーザーをミュートする（mute/create。相手に通知されず、いつでも解除可） */
export async function muteUser(env: MisskeyEnv, userId: string): Promise<void> {
  await mkApi(env, 'mute/create', { userId });
}

/** ユーザーのミュートを解除する（mute/delete） */
export async function unmuteUser(env: MisskeyEnv, userId: string): Promise<void> {
  await mkApi(env, 'mute/delete', { userId });
}

/** ユーザーをブロックする（blocking/create。相互作用を遮断） */
export async function blockUser(env: MisskeyEnv, userId: string): Promise<void> {
  await mkApi(env, 'blocking/create', { userId });
}

/** ユーザーのブロックを解除する（blocking/delete） */
export async function unblockUser(env: MisskeyEnv, userId: string): Promise<void> {
  await mkApi(env, 'blocking/delete', { userId });
}

/** 自分（ログイン中のアカウント）のユーザー ID。認証未設定時は null */
export async function getMyUserId(env: MisskeyEnv): Promise<string | null> {
  if (!env.MISSKEY_TOKEN) return null;
  const me = await mkApi<MkUser>(env, 'i');
  return me?.id ?? null;
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
