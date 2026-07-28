/** BFF (/api/*) を叩く薄い fetch クライアント */
import { API } from '../../shared/constants';
import type {
  DestinationCatalogEntry,
  EmojiInfo,
  Health,
  MediaUploadResponse,
  Post,
  PostInputWire,
  Provider,
  ProviderInfo,
  ReactionResponse,
  RecordUriResponse,
  Source,
  SourceCatalogEntry,
  TimelineResponse,
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
  /** ピッカー用のローカルカスタム絵文字一覧（Misskey のみ） */
  emojis: (provider: Provider = 'misskey') =>
    request<EmojiInfo[]>(`${API.emojis}?${new URLSearchParams({ provider }).toString()}`),
};
