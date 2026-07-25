/** フロント・Worker 共通のドメインモデル（最小抽象） */

export type Provider = 'bluesky' | 'mastodon'; // mixi2 は当面対象外

export type Media = { type: 'image'; url: string; alt?: string };

/** 投稿に添付された外部リンクのプレビューカード（高々1つ） */
export type LinkCard = { url: string; title: string; description: string; thumbUrl?: string };

export type Post = {
  id: string;
  provider: Provider;
  author: { handle: string; displayName: string; avatarUrl?: string };
  text: string;
  createdAt: string; // ISO 8601
  media: Media[];
  linkCard?: LinkCard;
  stats: { replies: number; reposts: number; likes: number };
  source: unknown; // 各SNSの生データ（bsky の uri/cid 等）
};

export type TimelineResponse = { posts: Post[]; nextCursor: string | null };

/** 投稿リクエスト（ブラウザ → BFF）。画像は事前アップロード済みの blob 参照 */
export type PostInputWire = {
  text: string;
  images?: { blob: unknown; alt: string }[];
  replyTo?: { uri: string; cid: string };
  quote?: { uri: string; cid: string };
  contentWarning?: string;
  langs?: string[];
};

export type MediaUploadResponse = { blob: unknown };

export type Health = {
  ok: boolean;
  service: string;
  session: 'configured' | 'missing-secrets';
  time: string;
};
