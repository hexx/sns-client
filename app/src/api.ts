/** BFF (/api/*) を叩く薄い fetch クライアント */
import { API } from '../../shared/constants';
import type {
  DestinationCatalogEntry,
  EmojiInfo,
  FollowRequest,
  FollowResponse,
  Health,
  MediaUploadResponse,
  MeResponse,
  NotificationsResponse,
  Post,
  PostInputWire,
  Profile,
  Provider,
  ProviderInfo,
  ReactionResponse,
  RecordUriResponse,
  Source,
  SourceCatalogEntry,
  ThreadResponse,
  TimelineResponse,
  UnfollowRequest,
  View,
} from '../../shared/types';

/** BFF 由来のエラー（status と、認証恒久失敗フラグを保持） */
export class ApiError extends Error {
  status: number;
  permanent?: boolean;
  provider?: Provider;
  constructor(status: number, message: string, extra?: { permanent?: boolean; provider?: Provider }) {
    super(message);
    this.status = status;
    this.permanent = extra?.permanent;
    this.provider = extra?.provider;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    let permanent: boolean | undefined;
    let provider: Provider | undefined;
    try {
      const body = (await res.json()) as { error?: string; permanent?: boolean; provider?: Provider };
      msg = body.error ?? msg;
      permanent = body.permanent;
      provider = body.provider;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg, { permanent, provider });
  }
  return res.json() as Promise<T>;
}

function sourceQuery(source: Source, cursor?: string): string {
  const q = new URLSearchParams({ provider: source.provider, kind: source.kind });
  if (source.id) q.set('id', source.id);
  if (cursor) q.set('cursor', cursor);
  return q.toString();
}

/** follow 解除の実装（unfollow のオーバーロード本体。bsky は recordUri 必須・misskey は不要） */
const unfollowImpl = (
  provider: 'bluesky' | 'misskey',
  actorId: string,
  recordUri?: string,
): Promise<Record<string, never>> =>
  request<Record<string, never>>(API.follow, {
    method: 'DELETE',
    body: JSON.stringify(
      (recordUri !== undefined ? { provider, actorId, recordUri } : { provider, actorId }) satisfies UnfollowRequest,
    ),
  });

export const api = {
  health: () => request<Health>(API.health),
  views: () => request<View[]>(API.views),
  /** カスタム View 定義の全量置換（単一ユーザー前提。docs/deck-view-spec.md §3） */
  saveViews: (views: View[]) =>
    request<View[]>(API.views, { method: 'PUT', body: JSON.stringify(views) }),
  /** ピッカー用の選択可能 Source 一覧（プロバイダ別。部分失敗は error フラグで返る） */
  sources: () => request<SourceCatalogEntry[]>(API.sources),
  /** Compose 用の選択可能 Destination 一覧（プロバイダ別。部分失敗は error フラグで返る。docs/compose-destination-spec.md） */
  destinations: () => request<DestinationCatalogEntry[]>(API.destinations),
  providers: () => request<ProviderInfo[]>(API.providers),
  timeline: (source: Source, cursor?: string) =>
    request<TimelineResponse>(`${API.timeline}?${sourceQuery(source, cursor)}`),
  /** スレッド取得（bsky/misskey。nostr はブラウザ直接解決のため app/src/lib/thread.ts 参照。docs/thread-view-spec.md §4） */
  thread: (provider: Provider, ref: unknown, cursor?: string) => {
    const q = new URLSearchParams({ provider, ref: JSON.stringify(ref) });
    if (cursor) q.set('cursor', cursor);
    return request<ThreadResponse>(`${API.thread}?${q.toString()}`);
  },
  /** プロフィール概要の取得（bsky/misskey。nostr はブラウザ直接解決のため app/src/lib/profile.ts 参照。docs/profile-view-spec.md §4） */
  profile: (provider: 'bluesky' | 'misskey', id: string) =>
    request<Profile>(`${API.profile}?${new URLSearchParams({ provider, id }).toString()}`),
  /** プロフィールの投稿一覧（TimelineResponse と同形状。docs/profile-view-spec.md §5） */
  profilePosts: (provider: 'bluesky' | 'misskey', id: string, cursor?: string) => {
    const q = new URLSearchParams({ provider, id });
    if (cursor) q.set('cursor', cursor);
    return request<TimelineResponse>(`${API.profilePosts}?${q.toString()}`);
  },
  /** フォロー（docs/profile-view-spec.md §6） */
  follow: (provider: 'bluesky' | 'misskey', actorId: string) =>
    request<FollowResponse>(API.follow, {
      method: 'POST',
      body: JSON.stringify({ provider, actorId } satisfies FollowRequest),
    }),
  /** フォロー解除（bsky は viewer.followUri を recordUri で渡す。misskey は不要）。
   * オーバーロードで bsky の recordUri 必須を型レベルで強制する（渡し忘れはコンパイルエラー） */
  unfollow: unfollowImpl as ((
    provider: 'bluesky',
    actorId: string,
    recordUri: string,
  ) => Promise<Record<string, never>>) &
    ((provider: 'misskey', actorId: string) => Promise<Record<string, never>>),
  uploadMedia: (provider: Provider, bytes: ArrayBuffer, mimeType: string, alt: string) =>
    request<MediaUploadResponse>(
      `${API.media}?${new URLSearchParams({ provider, alt }).toString()}`,
      { method: 'POST', body: bytes, headers: { 'content-type': mimeType } },
    ),
  post: (input: PostInputWire) =>
    request<Post>(API.post, { method: 'POST', body: JSON.stringify(input) }),
  /** Bluesky Like の作成（Post.ref の uri/cid を渡す） */
  like: (uri: string, cid: string) =>
    request<RecordUriResponse>(API.likes, { method: 'POST', body: JSON.stringify({ uri, cid }) }),
  /** Bluesky Like の解除（自分の like レコード URI） */
  unlike: (recordUri: string) =>
    request<RecordUriResponse>(API.likes, { method: 'DELETE', body: JSON.stringify({ recordUri }) }),
  /** リポスト（bsky ref={uri,cid} / misskey ref=noteId） */
  repost: (provider: Provider, ref: unknown) =>
    request<RecordUriResponse>(API.reposts, { method: 'POST', body: JSON.stringify({ provider, ref }) }),
  /** Bluesky Repost の解除（自分の repost レコード URI） */
  unrepost: (recordUri: string) =>
    request<RecordUriResponse>(API.reposts, { method: 'DELETE', body: JSON.stringify({ recordUri }) }),
  /** リアクションの付与/置換（reaction あり）または解除（reaction なし）。Misskey のみ */
  react: (postId: string, reaction?: string) =>
    request<ReactionResponse>(API.reactions, {
      method: 'POST',
      body: JSON.stringify(reaction ? { provider: 'misskey', postId, reaction } : { provider: 'misskey', postId }),
    }),
  /** 通知一覧（provider ごと。docs/notifications-spec.md §4.1） */
  notifications: (provider: 'bluesky' | 'misskey', cursor?: string) => {
    const q = new URLSearchParams({ provider });
    if (cursor) q.set('cursor', cursor);
    return request<NotificationsResponse>(`${API.notifications}?${q.toString()}`);
  },
  /** 通知の全既読（View 表示時の既読化。docs/notifications-spec.md §4.2） */
  markNotificationsRead: () => request<Record<string, never>>(API.notificationsRead, { method: 'POST' }),
  /** ピッカー用のローカルカスタム絵文字一覧（Misskey のみ） */
  emojis: (provider: Provider = 'misskey') =>
    request<EmojiInfo[]>(`${API.emojis}?${new URLSearchParams({ provider }).toString()}`),
  /** 自分のアクター識別子（docs/block-mute-spec.md §4.2。未設定 Provider は null） */
  me: () => request<MeResponse>(API.me),
  /** ユーザーのミュート（docs/block-mute-spec.md §4.1。actorId は Author.id） */
  mute: (provider: 'bluesky' | 'misskey', actorId: string) =>
    request<Record<string, never>>(API.mutes, { method: 'POST', body: JSON.stringify({ provider, actorId }) }),
  /** ユーザーのミュート解除 */
  unmute: (provider: 'bluesky' | 'misskey', actorId: string) =>
    request<Record<string, never>>(API.mutes, { method: 'DELETE', body: JSON.stringify({ provider, actorId }) }),
  /** ユーザーのブロック */
  block: (provider: 'bluesky' | 'misskey', actorId: string) =>
    request<Record<string, never>>(API.blocks, { method: 'POST', body: JSON.stringify({ provider, actorId }) }),
  /** ユーザーのブロック解除 */
  unblock: (provider: 'bluesky' | 'misskey', actorId: string) =>
    request<Record<string, never>>(API.blocks, { method: 'DELETE', body: JSON.stringify({ provider, actorId }) }),
};
