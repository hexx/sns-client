import { AtpAgent, AppBskyActorDefs, AppBskyFeedDefs, AppBskyRichtextFacet, RichText, type AtpSessionData } from '@atproto/api';
import type {
  LinkCard,
  Media,
  Notification,
  NotificationType,
  NotificationsResponse,
  Post,
  PostInputWire,
  Profile,
  RichSegment,
  Source,
  SourceOption,
  ThreadNode,
  ThreadResponse,
  TimelineResponse,
} from '../../shared/types';

const SERVICE = 'https://bsky.social';
const COL_LIKE = 'app.bsky.feed.like';
const COL_REPOST = 'app.bsky.feed.repost';
const COL_BLOCK = 'app.bsky.graph.block';
const COL_FOLLOW = 'app.bsky.graph.follow';
/** 通知一覧の1ページ件数と、対象投稿の補完取得バッチサイズ（docs/notifications-spec.md §4） */
const NOTIFICATION_LIMIT = 30;
const POSTS_BATCH = 25;

// --- セッション管理（単一ユーザー、モジュールスコープキャッシュ） ---
let agent: AtpAgent | undefined;
let loginInFlight: Promise<AtpAgent> | undefined;

export class BskyAuthError extends Error {}

function makeAgent(): AtpAgent {
  return new AtpAgent({
    service: SERVICE,
    // 'update' イベントでトークン自動更新時に呼ばれる（ここではメモリ保持のみ）
    persistSession: (_evt, sess: AtpSessionData | undefined) => {
      void sess;
    },
  });
}

/**
 * セッション付き Agent を返す。
 * - 有効なセッションがあれば再利用（期限切れは Agent 内部で自動リフレッシュ）
 * - なければ App Password で login
 */
export async function getAgent(handle?: string, appPassword?: string): Promise<AtpAgent> {
  if (agent?.session) return agent;
  if (!handle || !appPassword) throw new BskyAuthError('missing-secrets');
  if (!loginInFlight) {
    loginInFlight = (async () => {
      const a = makeAgent();
      await a.login({ identifier: handle, password: appPassword });
      agent = a;
      return a;
    })().finally(() => {
      loginInFlight = undefined;
    });
  }
  return loginInFlight;
}

/** 恒久認証失敗時に外部から呼んで再ログインを促す */
export function resetSession(): void {
  agent = undefined;
}

// --- facets → 統一 RichSegment（ADR-0005、docs/bsky-facets-spec.md） ---

/** 隣接する text セグメントを連結して間引く（misskey.ts の mergeText と同じ方針） */
function mergeText(segs: RichSegment[]): RichSegment[] {
  const out: RichSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (s.type === 'text' && last?.type === 'text') last.text += s.text;
    else out.push(s);
  }
  return out;
}

/**
 * 投稿レコードの facets を統一インラインリッチテキストへ変換する純粋関数。
 * - index は UTF-8 バイトオフセット（TextEncoder/Decoder 経由でスライス）
 * - 対応 feature: link / mention / tag。未知の feature はその範囲をプレーンテキストとして残す
 * - mention は hydration せず、表示テキスト由来の handle と DID 由来の bsky.app URL を付与
 * - 不正範囲・重複 facet はスキップ（先勝ち）。決してスローせず、異常時は undefined
 * - facets 無し/空/結果が全プレーンのみなら undefined（Post.rich を載せない）
 */
export function facetsToRich(text: string, facets: AppBskyRichtextFacet.Main[] | undefined): RichSegment[] | undefined {
  if (!facets?.length) return undefined;
  try {
    const bytes = new TextEncoder().encode(text);
    const decoder = new TextDecoder();
    const sorted = facets.toSorted((a, b) => (a.index?.byteStart ?? 0) - (b.index?.byteStart ?? 0));
    const out: RichSegment[] = [];
    let cursor = 0; // 採用済みのバイト位置
    for (const f of sorted) {
      const start = f.index?.byteStart;
      const end = f.index?.byteEnd;
      // 範囲不正（非数・負値・逆順・超過）や採用済み範囲との重複はスキップ
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        start < cursor ||
        start > end ||
        end > bytes.length
      )
        continue;
      // バイト境界がマルチバイト文字の途中（UTF-8 継続バイト 0x80-0xBF）に落ちる場合はスキップ
      if ((start > 0 && (bytes[start] & 0xc0) === 0x80) || (end < bytes.length && (bytes[end] & 0xc0) === 0x80))
        continue;

      const segText = decoder.decode(bytes.subarray(start, end));
      if (start > cursor) out.push({ type: 'text', text: decoder.decode(bytes.subarray(cursor, start)) });

      let seg: RichSegment = { type: 'text', text: segText };
      for (const ft of f.features ?? []) {
        // 型ガードで union を絞る（ガードは $type のみ検証するため、必須フィールドは明示チェック）。
        // 必須フィールド欠落 facet は seg を代入せずプレーンテキストのまま（壊れリンクを生成しない）
        if (AppBskyRichtextFacet.isLink(ft)) {
          if (ft.uri) seg = { type: 'link', url: ft.uri, text: segText };
          break;
        }
        if (AppBskyRichtextFacet.isMention(ft)) {
          if (ft.did)
            seg = { type: 'mention', handle: segText.replace(/^@/, ''), url: `https://bsky.app/profile/${ft.did}` };
          break;
        }
        if (AppBskyRichtextFacet.isTag(ft)) {
          if (ft.tag) seg = { type: 'hashtag', tag: ft.tag };
          break;
        }
      }
      out.push(seg);
      cursor = end;
    }
    if (cursor < bytes.length) out.push({ type: 'text', text: decoder.decode(bytes.subarray(cursor)) });

    const merged = mergeText(out);
    if (merged.length === 1 && merged[0].type === 'text') return undefined;
    return merged;
  } catch (e) {
    console.error('[bsky] facetsToRich failed', e);
    return undefined;
  }
}

// --- ドメインモデルへのマッピング ---

function extractMedia(embed: unknown): Media[] {
  const e = embed as { $type?: string; images?: unknown; media?: unknown } | undefined;
  if (!e) return [];
  if (e.$type === 'app.bsky.embed.images#view' && Array.isArray(e.images)) {
    return (e.images as { fullsize?: string; thumb?: string; alt?: string }[]).map((im) => ({
      type: 'image' as const,
      url: im.fullsize || im.thumb || '',
      alt: im.alt || '',
    }));
  }
  if (e.$type === 'app.bsky.embed.recordWithMedia#view' && e.media) {
    return extractMedia(e.media);
  }
  return [];
}

/**
 * LinkCard（外部リンクプレビュー）の抽出。
 * 対象は external#view と、recordWithMedia#view の media が external のケースのみ。
 * 引用（record#view）の引用先カードは対象外（quote card は本文・Media のみ描画、docs/quote-display-spec.md）。
 */
function extractLinkCard(embed: unknown): LinkCard | undefined {
  const e = embed as { $type?: string; external?: unknown; media?: unknown } | undefined;
  if (!e) return undefined;
  if (e.$type === 'app.bsky.embed.external#view' && e.external) {
    const ext = e.external as { uri?: string; title?: string; description?: string; thumb?: string };
    if (!ext.uri) return undefined;
    return {
      url: ext.uri,
      title: ext.title ?? '',
      description: ext.description ?? '',
      ...(ext.thumb ? { thumbUrl: ext.thumb } : {}),
    };
  }
  if (e.$type === 'app.bsky.embed.recordWithMedia#view' && e.media) {
    return extractLinkCard(e.media);
  }
  return undefined;
}

/** at:// URI から bsky.app の permalink を生成する（docs/quote-display-spec.md §permalink） */
function bskyPostUrl(uri: string): string | undefined {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  if (!m) return undefined;
  return `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
}

/** self-labels を CW テキストに連結する（docs/cw-display-spec.md、ADR-0016。値はそのまま、変換表無し） */
function labelsToCw(labels: { val?: string }[] | undefined): string | undefined {
  const vals = (labels ?? []).map((l) => l.val).filter((v): v is string => Boolean(v));
  return vals.length > 0 ? vals.join(', ') : undefined;
}

/**
 * 引用 embed の抽出（docs/quote-display-spec.md §Bluesky）。
 * record#view / recordWithMedia#view の record を解釈し、投稿（viewRecord）なら Post に映射、
 * viewNotFound/viewBlocked/viewDetached なら unavailable、投稿以外（list/feed gen）は skip。
 * ネスト引用（引用の引用）は捨てる（1階層のみ）。
 */
function extractQuote(embed: unknown, unwrapped = 0): { quote?: Post; quoteUnavailable?: boolean } {
  const e = embed as { $type?: string; record?: unknown } | undefined;
  if (!e) return {};
  if (e.$type === 'app.bsky.embed.recordWithMedia#view') {
    // 不正ペイロードの recordWithMedia 連鎖に備え、展開は1回までに制限する
    if (unwrapped >= 1) return {};
    return extractQuote(e.record, unwrapped + 1);
  }
  if (e.$type !== 'app.bsky.embed.record#view') return {};
  const rec = e.record as { $type?: string } | undefined;
  if (!rec) return {};
  if (rec.$type === 'app.bsky.embed.record#viewRecord') return { quote: mapQuotedRecord(rec) };
  if (
    rec.$type === 'app.bsky.embed.record#viewNotFound' ||
    rec.$type === 'app.bsky.embed.record#viewBlocked' ||
    rec.$type === 'app.bsky.embed.record#viewDetached'
  ) {
    return { quoteUnavailable: true };
  }
  return {}; // 投稿以外のレコード（list / feed generator 等）は skip
}

/** 引用先 post#viewRecord を Post に映射する（ネスト引用は捨てる。media・stats・cw・url は映射） */
function mapQuotedRecord(rec: unknown): Post {
  const r = rec as {
    uri: string;
    cid: string;
    // viewRecord の author は ProfileViewBasic で did が必須（ブロック/ミュートの対象識別子）
    author: { did: string; handle: string; displayName?: string; avatar?: string };
    value?: { text?: string; facets?: AppBskyRichtextFacet.Main[]; createdAt?: string };
    labels?: { val?: string }[];
    embeds?: unknown[];
    replyCount?: number;
    repostCount?: number;
    likeCount?: number;
    indexedAt?: string;
  };
  const text = r.value?.text ?? '';
  const rich = facetsToRich(text, r.value?.facets);
  const cw = labelsToCw(r.labels);
  const post: Post = {
    id: r.uri,
    provider: 'bluesky',
    author: {
      id: r.author.did,
      handle: r.author.handle,
      displayName: r.author.displayName || r.author.handle,
      avatarUrl: r.author.avatar,
    },
    text,
    createdAt: r.value?.createdAt ?? r.indexedAt ?? '',
    media: extractMedia(r.embeds?.[0]),
    stats: {
      replies: r.replyCount ?? 0,
      reposts: r.repostCount ?? 0,
      likes: r.likeCount ?? 0,
    },
    ref: { uri: r.uri, cid: r.cid },
    source: { uri: r.uri, cid: r.cid },
  };
  if (rich) post.rich = rich;
  if (cw) post.cw = cw;
  const url = bskyPostUrl(r.uri);
  if (url) post.url = url;
  return post;
}

export function mapPost(pv: AppBskyFeedDefs.PostView): Post {
  const rec = pv.record as { text?: string; facets?: AppBskyRichtextFacet.Main[] } | null | undefined;
  const text = rec?.text ?? '';
  const rich = facetsToRich(text, rec?.facets);
  const { quote, quoteUnavailable } = extractQuote(pv.embed);
  const cw = labelsToCw(pv.labels as { val?: string }[] | undefined);
  const url = bskyPostUrl(pv.uri);
  const post: Post = {
    id: pv.uri,
    provider: 'bluesky',
    author: {
      id: pv.author.did,
      handle: pv.author.handle,
      displayName: pv.author.displayName || pv.author.handle,
      avatarUrl: pv.author.avatar,
    },
    text,
    createdAt: pv.indexedAt,
    media: extractMedia(pv.embed),
    linkCard: extractLinkCard(pv.embed),
    stats: {
      replies: pv.replyCount ?? 0,
      reposts: pv.repostCount ?? 0,
      likes: pv.likeCount ?? 0,
    },
    ref: { uri: pv.uri, cid: pv.cid },
    viewer: buildViewer(pv.viewer),
    source: { uri: pv.uri, cid: pv.cid },
  };
  if (rich) post.rich = rich;
  if (quote) post.quote = quote;
  if (quoteUnavailable) post.quoteUnavailable = true;
  if (cw) post.cw = cw;
  if (url) post.url = url;
  return post;
}

/** 自分の操作状態（like/repost レコード URI）を Post.viewer へ整形する。操作無しなら undefined */
function buildViewer(viewer: { like?: string; repost?: string } | undefined): Post['viewer'] {
  if (!viewer?.like && !viewer?.repost) return undefined;
  return {
    ...(viewer.like ? { likeUri: viewer.like } : {}),
    ...(viewer.repost ? { repostUri: viewer.repost } : {}),
  };
}

// --- BFF 処理本体 ---

/**
 * Source 種別（home / list / feed）を Bluesky のフィード API へ dispatch する。
 * list = app.bsky.feed.getListFeed (list AT-URI)、feed = app.bsky.feed.getFeed (generator AT-URI)。
 * 3者とも応答形は { feed: [{post}], cursor } で共通。
 */
export async function getTimeline(
  handle: string | undefined,
  appPassword: string | undefined,
  source: Source,
  cursor?: string,
): Promise<TimelineResponse> {
  const a = await getAgent(handle, appPassword);
  let res: { data: { feed: { post: AppBskyFeedDefs.PostView }[]; cursor?: string } };
  if (source.kind === 'list') {
    if (!source.id) throw new Error('list source requires id');
    res = await a.app.bsky.feed.getListFeed({ list: source.id, cursor, limit: 30 });
  } else if (source.kind === 'feed') {
    if (!source.id) throw new Error('feed source requires id');
    res = await a.app.bsky.feed.getFeed({ feed: source.id, cursor, limit: 30 });
  } else {
    res = await a.getTimeline({ cursor, limit: 30 });
  }
  return {
    posts: res.data.feed.map((f) => mapPost(f.post)),
    nextCursor: res.data.cursor ?? null,
  };
}

/** getPostThread 応答のノード union（@atproto/api の型は $Typed で扱いにくいため、識別子で絞るローカル型） */
type AnyThreadView =
  | AppBskyFeedDefs.ThreadViewPost
  | AppBskyFeedDefs.NotFoundPost
  | AppBskyFeedDefs.BlockedPost
  | { $type?: string };

function isPostNode(v: AnyThreadView): v is AppBskyFeedDefs.ThreadViewPost {
  return AppBskyFeedDefs.isThreadViewPost(v);
}

/**
 * getPostThread の応答木を ThreadResponse に解釈する純粋関数（docs/thread-view-spec.md §4.2、ADR-0017）。
 * - フォーカス自体が notFound/blocked（削除・ブロック等）なら null（呼び出し側が 404 にする）。
 * - 祖先: .parent 連鎖を収集して root 先頭に反転（parentHeight 上限は API 引数で制約）。
 *   途中で notFound/blocked に当たったらそこで打ち切り（ancestors は Post[] でプレースホルダを持たない）。
 * - 子孫: .replies を DFS で平坦化し depth（focus 直下=1）を付与。notFound/blocked は unavailable ノード。
 */
export function threadViewToResponse(thread: AnyThreadView): ThreadResponse | null {
  if (!isPostNode(thread)) return null;
  const focus = mapPost(thread.post);
  const ancestors: Post[] = [];
  let parent: AnyThreadView | undefined = thread.parent as AnyThreadView | undefined;
  while (parent && isPostNode(parent)) {
    ancestors.push(mapPost(parent.post));
    parent = parent.parent as AnyThreadView | undefined;
  }
  ancestors.reverse();
  const replies: ThreadNode[] = [];
  const walk = (nodes: AnyThreadView[] | undefined, depth: number) => {
    for (const n of nodes ?? []) {
      if (isPostNode(n)) {
        replies.push({ post: mapPost(n.post), depth });
        walk(n.replies as AnyThreadView[] | undefined, depth + 1);
      } else {
        replies.push({ unavailable: true, depth });
      }
    }
  };
  walk(thread.replies as AnyThreadView[] | undefined, 1);
  return { focus, ancestors, replies, nextCursor: null };
}

/**
 * スレッド取得（docs/thread-view-spec.md §4.2）。uri はフォーカス投稿の AT-URI（Post.ref.uri）。
 * フォーカス取得不能（notFound/blocked）は null を返す（ルートが 404 にマップ）。
 */
export async function getThread(
  handle: string | undefined,
  appPassword: string | undefined,
  uri: string,
): Promise<ThreadResponse | null> {
  const a = await getAgent(handle, appPassword);
  try {
    const res = await a.getPostThread({ uri, depth: 10, parentHeight: 25 });
    return threadViewToResponse(res.data.thread as AnyThreadView);
  } catch (e) {
    // 削除済み等でアンカーが解決できない場合、appview は notFound ノードではなく NotFound（HTTP 400）を投げる。
    // そのままでは 502 になるため、focus 取得不能（null → ルートが 404 にマップ）として扱う（§4.2）。
    if ((e as { error?: string })?.error === 'NotFound') return null;
    throw e;
  }
}

// --- プロフィール（docs/profile-view-spec.md §4/§5） ---

/** getProfile 応答（ProfileViewDetailed）を統一 Profile へ映射する純粋関数 */
export function mapProfile(pv: AppBskyActorDefs.ProfileViewDetailed): Profile {
  const profile: Profile = {
    provider: 'bluesky',
    author: {
      id: pv.did,
      handle: pv.handle,
      displayName: pv.displayName || pv.handle,
      ...(pv.avatar ? { avatarUrl: pv.avatar } : {}),
    },
    url: `https://bsky.app/profile/${pv.did}`,
  };
  if (pv.description) profile.description = pv.description;
  if (pv.banner) profile.bannerUrl = pv.banner;
  if (pv.postsCount !== undefined || pv.followsCount !== undefined || pv.followersCount !== undefined) {
    profile.stats = {
      posts: pv.postsCount ?? 0,
      following: pv.followsCount ?? 0,
      followers: pv.followersCount ?? 0,
    };
  }
  if (pv.viewer?.following) {
    profile.viewer = { following: true, followUri: pv.viewer.following };
  } else if (pv.viewer) {
    profile.viewer = { following: false };
  }
  return profile;
}

/** getAuthorFeed の1アイテムを Post へ映射する（reasonRepost → repostedBy。profile-view-spec §5.1） */
export function mapAuthorFeedItem(f: {
  post: AppBskyFeedDefs.PostView;
  reason?: { $type?: string; by?: { did: string; handle: string; displayName?: string; avatar?: string } };
}): Post {
  const post = mapPost(f.post);
  if (f.reason?.$type === 'app.bsky.feed.defs#reasonRepost' && f.reason.by) {
    post.repostedBy = {
      id: f.reason.by.did,
      handle: f.reason.by.handle,
      displayName: f.reason.by.displayName || f.reason.by.handle,
      ...(f.reason.by.avatar ? { avatarUrl: f.reason.by.avatar } : {}),
    };
  }
  return post;
}

/**
 * アカウント取得不能の判定（削除・ブロック・停止・BAN 等。§9 の 404 マップに使う）。
 * 既知のエラーコードを先に厳密に照合し、メッセージはフォールバックで見る
 * （getThread の error === 'NotFound' / unblockActor の RecordNotFound と同じ流儀）。
 */
export function isAccountUnavailable(e: unknown): boolean {
  const code = (e as { error?: string })?.error ?? '';
  if (/(NotFound|AccountNotFound|RepoNotFound|BlockedActor|AccountTakedown|Deactivated)/i.test(code)) return true;
  const msg = String((e as { message?: string })?.message ?? '');
  // メッセージは語境界で照合する（getaddrinfo ENOTFOUND や unblocked 等の誤判定を防ぐ）。
  // 「not found」「take(n) down」は空白有無どちらでも（not found / taken down）
  return /\b(not ?found|blocked|taken? ?down|deactivated)\b/i.test(msg);
}

/** 取得不能アカウントを null に縮退するラッパー（getProfile / getProfilePosts の共通処理） */
async function withUnavailableAsNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    // そのままでは 502 になるため、取得不能（null → ルートが 404 にマップ）として扱う（§9）
    if (isAccountUnavailable(e)) return null;
    throw e;
  }
}

/**
 * プロフィール概要の取得（docs/profile-view-spec.md §4.2）。id は DID（Author.id）。
 * 削除済み・ブロック等で解決できない場合は null を返す（ルートが 404 → クライアントはプレースホルダ表示）。
 */
export async function getProfile(
  handle: string | undefined,
  appPassword: string | undefined,
  did: string,
): Promise<Profile | null> {
  const a = await getAgent(handle, appPassword);
  return withUnavailableAsNull(async () => {
    const res = await a.getProfile({ actor: did });
    return mapProfile(res.data as AppBskyActorDefs.ProfileViewDetailed);
  });
}

/**
 * プロフィールの投稿一覧（docs/profile-view-spec.md §5.1）。
 * filter: 'posts_no_replies' で投稿＋リポストのみ（リプライ除外。理由は §5.1）。
 * リポストは reasonRepost を repostedBy に映射（既存タイムラインは reason を無視するため新規）。
 * 削除済み・ブロック等で解決できない場合は null（ルートが 404 → クライアントはエラー行表示。§8.2）。
 */
export async function getProfilePosts(
  handle: string | undefined,
  appPassword: string | undefined,
  did: string,
  cursor?: string,
): Promise<TimelineResponse | null> {
  const a = await getAgent(handle, appPassword);
  return withUnavailableAsNull(async () => {
    const res = await a.getAuthorFeed({ actor: did, limit: 30, ...(cursor ? { cursor } : {}), filter: 'posts_no_replies' });
    return {
      posts: (res.data.feed ?? []).map(mapAuthorFeedItem),
      nextCursor: res.data.cursor ?? null,
    };
  });
}

/** フォローを作成し、自分の follow レコード URI を返す（docs/profile-view-spec.md §6） */
export async function followActor(
  handle: string | undefined,
  appPassword: string | undefined,
  did: string,
): Promise<string> {
  return createRecord(handle, appPassword, COL_FOLLOW, { subject: did });
}

/** フォローを解除する（自分の follow レコード URI 指定） */
export async function unfollowActor(
  handle: string | undefined,
  appPassword: string | undefined,
  recordUri: string,
): Promise<void> {
  return deleteRecord(handle, appPassword, COL_FOLLOW, recordUri);
}

// --- 通知（docs/notifications-spec.md、ADR-0019） ---

/**
 * 投稿を伴う reason の対象投稿 URI を決める（mention/reply/quote は通知自身の record、like/repost は reasonSubject）。
 * 投稿を伴わない reason（follow 等）は undefined。
 */
export function bskySubjectUriOf(reason: string, uri: string, reasonSubject?: string): string | undefined {
  switch (reason) {
    case 'mention':
    case 'reply':
    case 'quote':
    case 'subscribed-post':
      return uri;
    case 'like':
    case 'repost':
    case 'like-via-repost':
    case 'repost-via-repost':
      return reasonSubject;
    default:
      return undefined;
  }
}

/** bsky の reason を統一 NotificationType へ写像する（未知 reason は生のまま。UI はフィールドの有無で描画を決める） */
export function bskyReasonToType(reason: string): NotificationType {
  switch (reason) {
    case 'mention':
    case 'reply':
    case 'quote':
    case 'like':
    case 'repost':
    case 'follow':
    case 'like-via-repost':
    case 'repost-via-repost':
    case 'subscribed-post':
    case 'starterpack-joined':
    case 'contact-match':
    case 'verified':
    case 'unverified':
      return reason;
    default:
      return reason as NotificationType;
  }
}

/** listNotifications の1通知を統一 Notification に写像する純粋関数（対象投稿は postsByUri で解決。ADR-0019） */
export function mapBskyNotification(
  n: {
    uri: string;
    reason: string;
    reasonSubject?: string;
    indexedAt?: string;
    isRead?: boolean;
    author: { did: string; handle: string; displayName?: string; avatar?: string };
  },
  postsByUri: Map<string, Post>,
): Notification {
  const type = bskyReasonToType(n.reason);
  const notif: Notification = {
    id: n.uri,
    provider: 'bluesky',
    type,
    createdAt: n.indexedAt ?? '',
    isRead: n.isRead ?? false,
    actor: {
      id: n.author.did,
      handle: n.author.handle,
      displayName: n.author.displayName || n.author.handle,
      ...(n.author.avatar ? { avatarUrl: n.author.avatar } : {}),
    },
  };
  const subjectUri = bskySubjectUriOf(n.reason, n.uri, n.reasonSubject);
  if (subjectUri) {
    const post = postsByUri.get(subjectUri);
    if (post) notif.post = post;
    else notif.postUnavailable = true; // 取得不能（削除・ブロック等）は遷移先なし（§7）
  }
  if (type === 'verified') notif.text = 'あなたのアカウントが認証されました';
  if (type === 'unverified') notif.text = 'あなたのアカウントの認証が解除されました';
  return notif;
}

/**
 * 通知一覧（docs/notifications-spec.md §4.1）。like/repost 系は対象投稿がペイロードに無いため
 * getPosts バッチ（25 URI/回）で補完取得する（ADR-0019）。部分失敗は該当通知を postUnavailable に縮退。
 */
export async function getNotifications(
  handle: string | undefined,
  appPassword: string | undefined,
  cursor?: string,
): Promise<NotificationsResponse> {
  const a = await getAgent(handle, appPassword);
  const res = await a.app.bsky.notification.listNotifications({ limit: NOTIFICATION_LIMIT, ...(cursor ? { cursor } : {}) });
  const notifications = res.data.notifications ?? [];
  const subjectUris = [
    ...new Set(
      notifications
        .map((n) => bskySubjectUriOf(n.reason, n.uri, n.reasonSubject))
        .filter((u): u is string => Boolean(u)),
    ),
  ];
  const postsByUri = new Map<string, Post>();
  const batches: Promise<void>[] = [];
  for (let i = 0; i < subjectUris.length; i += POSTS_BATCH) {
    const uris = subjectUris.slice(i, i + POSTS_BATCH);
    batches.push(
      a
        .getPosts({ uris })
        .then((r) => {
          for (const pv of r.data.posts ?? []) postsByUri.set(pv.uri, mapPost(pv));
        })
        .catch((e) => {
          console.error('[bsky] getPosts failed (notifications)', e);
        }),
    );
  }
  await Promise.all(batches);
  // 未読数は補助データ: 取得失敗でも一覧は返す（未読バッジは 0 に縮退。次回ポーリングで回復）
  let unreadCount = 0;
  try {
    const unread = await a.app.bsky.notification.getUnreadCount();
    unreadCount = unread.data.count ?? 0;
  } catch (e) {
    console.error('[bsky] getUnreadCount failed', e);
  }
  return {
    notifications: notifications.map((n) => mapBskyNotification(n, postsByUri)),
    unreadCount,
    nextCursor: res.data.cursor ?? null,
  };
}

/** 通知の全既読（updateSeen。docs/notifications-spec.md §4.2） */
export async function markNotificationsRead(
  handle: string | undefined,
  appPassword: string | undefined,
): Promise<void> {
  const a = await getAgent(handle, appPassword);
  await a.app.bsky.notification.updateSeen({ seenAt: new Date().toISOString() });
}

/**
 * ピッカー用の選択可能 Source 一覧（ホーム + 自作リスト + saved feeds/pinned lists）。
 * - 自作リスト: app.bsky.graph.getLists(actor=self)
 * - saved feeds / ピン留めリスト（フォロー中リストを含む）: actor preferences の savedFeedsPrefV2 を
 *   getList / getFeedGenerator で hydrate して名前を得る。部分失敗は当該項目をスキップ。
 */
export async function listSources(
  handle: string | undefined,
  appPassword: string | undefined,
): Promise<SourceOption[]> {
  const a = await getAgent(handle, appPassword);
  const options: SourceOption[] = [{ source: { provider: 'bluesky', kind: 'home' }, name: 'ホーム' }];

  const did = a.session?.did;
  if (did) {
    try {
      const res = await a.app.bsky.graph.getLists({ actor: did, limit: 100 });
      for (const l of res.data.lists) {
        options.push({ source: { provider: 'bluesky', kind: 'list', id: l.uri }, name: l.name });
      }
    } catch (e) {
      console.error('[bsky] getLists failed', e);
    }
  }

  try {
    const prefs = await a.app.bsky.actor.getPreferences();
    const saved = prefs.data.preferences.find(
      (p): p is { $type: string; items: { type: string; value: string }[] } =>
        p.$type === 'app.bsky.actor.defs#savedFeedsPrefV2',
    );
    const seen = new Set(options.map((o) => o.source.id).filter(Boolean));
    const items = (saved?.items ?? []).filter((it) => (it.type === 'list' || it.type === 'feed') && !seen.has(it.value));
    await Promise.all(
      items.map(async (it) => {
        try {
          if (it.type === 'list') {
            const r = await a.app.bsky.graph.getList({ list: it.value, limit: 1 });
            options.push({ source: { provider: 'bluesky', kind: 'list', id: it.value }, name: r.data.list.name });
          } else {
            const r = await a.app.bsky.feed.getFeedGenerator({ feed: it.value });
            options.push({
              source: { provider: 'bluesky', kind: 'feed', id: it.value },
              name: r.data.view.displayName,
            });
          }
        } catch (e) {
          console.error(`[bsky] hydrate ${it.type} failed`, e);
        }
      }),
    );
  } catch (e) {
    console.error('[bsky] getPreferences failed', e);
  }

  return options;
}

// --- Like / Repost 操作（docs/deck-view-spec.md §6。自分の操作は viewer のレコード URI でトグルする） ---

function rkeyOf(recordUri: string): string {
  // at://did/collection/rkey → rkey
  const rkey = recordUri.split('/').pop();
  if (!rkey) throw new Error(`invalid record uri: ${recordUri}`);
  return rkey;
}

async function createRecord(
  handle: string | undefined,
  appPassword: string | undefined,
  collection: string,
  record: Record<string, unknown>,
): Promise<string> {
  const a = await getAgent(handle, appPassword);
  const did = a.session?.did;
  if (!did) throw new BskyAuthError('no-session');
  const res = await a.com.atproto.repo.createRecord({
    repo: did,
    collection,
    record: { ...record, createdAt: new Date().toISOString() },
  });
  return res.data.uri;
}

async function deleteRecord(
  handle: string | undefined,
  appPassword: string | undefined,
  collection: string,
  recordUri: string,
): Promise<void> {
  const a = await getAgent(handle, appPassword);
  const did = a.session?.did;
  if (!did) throw new BskyAuthError('no-session');
  await a.com.atproto.repo.deleteRecord({ repo: did, collection, rkey: rkeyOf(recordUri) });
}

/** Like を作成し、自分の like レコード URI を返す */
export async function likePost(
  handle: string | undefined,
  appPassword: string | undefined,
  uri: string,
  cid: string,
): Promise<string> {
  return createRecord(handle, appPassword, COL_LIKE, { subject: { uri, cid } });
}

/** Like を解除する（自分の like レコード URI 指定） */
export async function unlikePost(
  handle: string | undefined,
  appPassword: string | undefined,
  recordUri: string,
): Promise<void> {
  return deleteRecord(handle, appPassword, COL_LIKE, recordUri);
}

/** Repost を作成し、自分の repost レコード URI を返す */
export async function repostPost(
  handle: string | undefined,
  appPassword: string | undefined,
  uri: string,
  cid: string,
): Promise<string> {
  return createRecord(handle, appPassword, COL_REPOST, { subject: { uri, cid } });
}

/** Repost を解除する（自分の repost レコード URI 指定） */
export async function unrepostPost(
  handle: string | undefined,
  appPassword: string | undefined,
  recordUri: string,
): Promise<void> {
  return deleteRecord(handle, appPassword, COL_REPOST, recordUri);
}

// --- ブロック・ミュート操作（docs/block-mute-spec.md。actor は DID で指定） ---

/** ユーザーをミュートする（muteActor。相手に通知されず、いつでも解除可） */
export async function muteActor(
  handle: string | undefined,
  appPassword: string | undefined,
  actorDid: string,
): Promise<void> {
  const a = await getAgent(handle, appPassword);
  await a.app.bsky.graph.muteActor({ actor: actorDid });
}

/** ユーザーのミュートを解除する（unmuteActor） */
export async function unmuteActor(
  handle: string | undefined,
  appPassword: string | undefined,
  actorDid: string,
): Promise<void> {
  const a = await getAgent(handle, appPassword);
  await a.app.bsky.graph.unmuteActor({ actor: actorDid });
}

/**
 * ユーザーをブロックする（app.bsky.graph.block レコード）。
 * 公式クライアントと同じ規約で rkey を対象 DID に固定し、putRecord（作成/置換）で書くため、
 * 既にブロック済みでも再実行は置換になり冪等。解除時にレコード URI の検索が不要になる。
 */
export async function blockActor(
  handle: string | undefined,
  appPassword: string | undefined,
  actorDid: string,
): Promise<void> {
  const a = await getAgent(handle, appPassword);
  const did = a.session?.did;
  if (!did) throw new BskyAuthError('no-session');
  await a.com.atproto.repo.putRecord({
    repo: did,
    collection: COL_BLOCK,
    rkey: actorDid,
    record: { subject: actorDid, createdAt: new Date().toISOString() },
  });
}

/**
 * ユーザーのブロックを解除する（block レコード削除。rkey＝対象 DID）。
 * 未ブロック（レコード無し）の RecordNotFound は成功扱いにして冪等にする。
 */
export async function unblockActor(
  handle: string | undefined,
  appPassword: string | undefined,
  actorDid: string,
): Promise<void> {
  try {
    await deleteRecord(handle, appPassword, COL_BLOCK, `at://${actorDid}/${COL_BLOCK}/${actorDid}`);
  } catch (e) {
    if ((e as { error?: string })?.error === 'RecordNotFound') return;
    throw e;
  }
}

/** 自分（ログイン中のアカウント）の DID。認証未設定・未ログイン時は null */
export async function getMyDid(handle: string | undefined, appPassword: string | undefined): Promise<string | null> {
  if (!handle || !appPassword) return null;
  const a = await getAgent(handle, appPassword);
  return a.session?.did ?? null;
}

/** 画像をアップロードし blob 参照を返す */
export async function uploadMedia(
  handle: string | undefined,
  appPassword: string | undefined,
  bytes: ArrayBuffer,
  mimeType: string,
): Promise<unknown> {
  const a = await getAgent(handle, appPassword);
  const res = await a.uploadBlob(new Uint8Array(bytes), { encoding: mimeType });
  return res.data.blob;
}

/** 投稿レコードを構築する純粋関数（テスト容易化のため分離） */
export function buildPostRecord(input: PostInputWire, rt: RichText): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record: any = { text: rt.text };
  if (rt.facets?.length) record.facets = rt.facets;
  if (input.langs?.length) record.langs = input.langs;

  const images = input.images ?? [];
  const imagesEmbed = images.length
    ? {
        $type: 'app.bsky.embed.images',
        images: images.map((i) => ({ alt: i.alt ?? '', image: i.blob })),
      }
    : null;
  const quoteRef = input.quote as { uri: string; cid: string } | undefined;
  const quoteEmbed = quoteRef
    ? { $type: 'app.bsky.embed.record', record: { uri: quoteRef.uri, cid: quoteRef.cid } }
    : null;

  if (imagesEmbed && quoteEmbed) {
    record.embed = { $type: 'app.bsky.embed.recordWithMedia', media: imagesEmbed, record: quoteEmbed };
  } else if (imagesEmbed) {
    record.embed = imagesEmbed;
  } else if (quoteEmbed) {
    record.embed = quoteEmbed;
  }

  const replyRef = input.replyTo as { uri: string; cid: string } | undefined;
  if (replyRef) {
    // MVP: 返信対象を root かつ parent とする（トップレベル投稿への返信で正しい）
    const ref = { uri: replyRef.uri, cid: replyRef.cid };
    record.reply = { root: ref, parent: ref };
  }

  if (input.contentWarning) {
    record.labels = {
      $type: 'com.atproto.label.defs#selfLabels',
      values: [{ val: input.contentWarning }],
    };
  }

  return record;
}

/** 投稿を作成し、統合 Post として返す */
export async function createPost(
  handle: string | undefined,
  appPassword: string | undefined,
  input: PostInputWire,
): Promise<Post> {
  const a = await getAgent(handle, appPassword);

  // リンク/メンション/タグの facets 検出（メンションは DID 解決まで行う）
  const rt = new RichText({ text: input.text });
  await rt.detectFacets(a);

  const record = buildPostRecord(input, rt);
  const images = input.images ?? [];

  const res = await a.post(record);

  // 作成した投稿を再取得し、実際のメディア URL やプロフィール情報を反映する。
  // （a.post の応答は {uri,cid} のみで画像 URL を含まないため、そのままでは UI で画像が壊れる）
  try {
    const view = await a.getPosts({ uris: [res.uri] });
    const pv = view.data.posts[0];
    if (pv) return mapPost(pv);
  } catch (e) {
    console.error('[createPost] refetch failed', e);
  }

  // フォールバック: 手元情報で組み立て（メディア URL は空、UI 側で空 URL は表示しない）
  const createdAt = new Date().toISOString();
  const sess = a.session;
  const fallbackRich = facetsToRich(rt.text, rt.facets);
  return {
    id: res.uri,
    provider: 'bluesky',
    author: {
      id: sess?.did ?? '',
      handle: sess?.handle ?? handle ?? '',
      displayName: sess?.handle ?? handle ?? '',
    },
    text: rt.text,
    ...(fallbackRich ? { rich: fallbackRich } : {}),
    createdAt,
    media: images.map((i) => ({ type: 'image' as const, url: '', alt: i.alt })),
    stats: { replies: 0, reposts: 0, likes: 0 },
    source: { uri: res.uri, cid: res.cid },
  };
}
