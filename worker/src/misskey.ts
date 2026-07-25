/**
 * Misskey プロバイダ（raw fetch クライアント）。
 * API は `${instance}/api/*` への JSON POST（ボディの `i` で認証）。
 * mfm-js は MFM パース（本文のリッチ化）にのみ使用。
 */
import { parse, toString } from 'mfm-js';
import type {
  Author,
  Media,
  Post,
  PostInputWire,
  Reaction,
  RichSegment,
  TimelineResponse,
  Visibility,
} from '../../shared/types';

const DEFAULT_INSTANCE = 'https://misskey.io';
const LIMIT = 30;

export class MisskeyAuthError extends Error {}

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

function authorOf(u: MkUser): Author {
  const handle = u.host ? `${u.username}@${u.host}` : u.username;
  return {
    handle,
    displayName: u.name || u.username,
    ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
  };
}

function mediaOf(files: MkFile[] | undefined): Media[] {
  if (!files) return [];
  return files
    .filter((f) => f.type.startsWith('image/'))
    .map((f) => ({ type: 'image' as const, url: f.url || f.thumbnailUrl || '', alt: f.comment || '' }));
}

function reactionsOf(note: MkNote): { reactions?: Reaction[]; likes: number } {
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
      if (note.myReaction === key) reaction.me = true;
      return reaction;
    });
  return { reactions, likes };
}

/** ノート自身のフィールドを Post に映射する（renote/quote は扱わない） */
function basePost(note: MkNote): Post {
  const text = note.text ?? '';
  const { rich, plain } = text ? mfmToRich(text, emojiMap(note.emojis)) : { rich: undefined, plain: '' };
  const { reactions, likes } = reactionsOf(note);
  const post: Post = {
    id: note.id,
    provider: 'misskey',
    author: authorOf(note.user),
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
export function mapNote(note: MkNote): Post {
  if (isPureRenote(note) && note.renote) {
    const inner = basePost(note.renote);
    return {
      ...inner,
      id: note.id, // renote 活動ごとに一意（dedup されすぎない）
      createdAt: note.createdAt, // フィードに現れた時刻（マージ順序の歪みを避ける）
      repostedBy: authorOf(note.user),
      source: note,
    };
  }
  const post = basePost(note);
  if (note.renote && !isPureRenote(note)) {
    // 本文付き引用、またはテキスト無しでもメディア付きの引用を拾う（1階層、ネスト引用は落とす）
    post.quote = basePost(note.renote);
  }
  return post;
}

// --- BFF 処理本体 ---

export async function getTimeline(env: MisskeyEnv, cursor?: string): Promise<TimelineResponse> {
  const params: Record<string, unknown> = { limit: LIMIT };
  if (cursor) params.untilId = cursor;
  const notes = await mkApi<MkNote[]>(env, 'notes/timeline', params);
  const posts = notes.map(mapNote);
  return { posts, nextCursor: notes.length > 0 ? notes[notes.length - 1].id : null };
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
  const res = await mkApi<{ createdNote: MkNote }>(env, 'notes/create', params);
  return mapNote(res.createdNote);
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
