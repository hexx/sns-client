/** フロント・Worker 共通のドメインモデル（最小抽象） */

export type Provider = 'bluesky' | 'misskey' | 'mastodon'; // mastodon は型上予約のみ

export type Media = { type: 'image'; url: string; alt?: string };

/** 投稿に添付された外部リンクのプレビューカード（高々1つ） */
export type LinkCard = { url: string; title: string; description: string; thumbUrl?: string };

/** 1つの Provider に属する投稿ストリーム（home / feed / antenna ...） */
export type Source = { provider: Provider; kind: string; id?: string };

/** 表示画面の定義。1つ以上の Source の集合（クライアントが時系列合成する） */
export type View = { id: string; name: string; sources: Source[] };

export type Author = { handle: string; displayName: string; avatarUrl?: string };

/** 統一インラインリッチテキスト（ADR-0005）。BFF が MFM/facets から生成 */
export type RichSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; url: string; text?: string }
  | { type: 'mention'; handle: string; url?: string }
  | { type: 'hashtag'; tag: string }
  | { type: 'emoji'; name: string; url?: string; char?: string };

/** 投稿への絵文字反応（Misskey は複数種、Bluesky は likes 総数のみで本リストは無し） */
export type Reaction = {
  emoji: string; // Unicode 絵文字、またはカスタム絵文字名 ":name:"
  emojiUrl?: string; // カスタム絵文字の画像URL（Unicode なら無し）
  count: number;
  me?: boolean; // 自分がこの絵文字で反応したか
};

export type Visibility = 'public' | 'home' | 'followers' | 'specified';

export type Post = {
  id: string;
  provider: Provider;
  author: Author;
  repostedBy?: Author; // 純粋repost/renote の再共有者（引用では無し）
  text: string; // プレーンテキスト（フォールバック/検索用）
  rich?: RichSegment[]; // リッチ本文（あれば UI はこちらを描画）
  createdAt: string; // ISO 8601
  media: Media[];
  linkCard?: LinkCard;
  quote?: Post; // 引用で埋め込まれた投稿（描画は1階層のみ）
  stats: { replies: number; reposts: number; likes: number }; // likes=反応総数
  reactions?: Reaction[]; // 絵文字別内訳（Misskey のみ）
  visibility?: Visibility; // 任意（Misskey）
  localOnly?: boolean; // 任意（Misskey）
  ref?: unknown; // プロバイダ固有の自己参照（bsky={uri,cid} / misskey=noteId）
  source: unknown; // 各SNSの生データ退避
};

export type TimelineResponse = { posts: Post[]; nextCursor: string | null };

/** 投稿リクエスト（ブラウザ → BFF）。画像は事前アップロード済みの opaque 参照 */
export type PostInputWire = {
  provider: Provider; // 投稿先（単一ターゲット）
  text: string;
  images?: { blob: unknown; alt: string }[]; // blob は opaque（bsky=blob / misskey=drive fileId）
  replyTo?: unknown; // opaque（Post.ref をエコー）。BFF がプロバイダごとに解釈
  quote?: unknown; // 同上
  contentWarning?: string; // bsky=self-labels / misskey=cw
  langs?: string[]; // bsky のみ（misskey は無視）
  visibility?: 'public' | 'home' | 'followers'; // misskey のみ（specified は対象外）
  localOnly?: boolean; // misskey のみ
};

export type MediaUploadResponse = { blob: unknown };

/** プロバイダの compose 設定（カウンタの単位と上限） */
export type ComposeConfig = {
  charLimit: number;
  unit: 'grapheme' | 'char';
};

export type ProviderInfo = {
  provider: Provider;
  configured: boolean;
  compose: ComposeConfig;
};

export type Health = {
  ok: boolean;
  service: string;
  session: 'configured' | 'missing-secrets';
  time: string;
};
