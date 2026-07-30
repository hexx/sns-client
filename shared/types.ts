/** フロント・Worker 共通のドメインモデル（最小抽象） */

export type Provider = 'bluesky' | 'misskey' | 'mastodon' | 'mixi2' | 'nostr'; // mastodon・mixi2 は型上予約のみ（mixi2: docs/mixi2-integration-spec.md）。nostr は読み取り専用（docs/nostr-integration-spec.md、ADR-0013）

export type Media = { type: 'image'; url: string; alt?: string };

/** 投稿に添付された外部リンクのプレビューカード（高々1つ） */
export type LinkCard = { url: string; title: string; description: string; thumbUrl?: string };

/** 1つの Provider に属する投稿ストリーム（home / feed / antenna ...） */
export type Source = { provider: Provider; kind: string; id?: string };

/** 表示画面の定義。1つ以上の Source の集合（クライアントが時系列合成する） */
export type View = { id: string; name: string; sources: Source[] };

/** ピッカー用の選択可能 Source（人間可読名付き）。/api/sources が配信する */
export type SourceOption = { source: Source; name: string };

/** /api/sources のプロバイダ別エントリ。片方失敗しても他方を返せるよう error を持つ */
export type SourceCatalogEntry = { provider: Provider; options: SourceOption[]; error?: boolean };

/** 新しい Post の提出先（書き込み側）。Source と対になる概念（docs/compose-destination-spec.md） */
export type Destination = { provider: Provider; kind: 'home' | 'channel'; id?: string };

/** ピッカー用の選択可能 Destination（人間可読名付き）。/api/destinations が配信する */
export type DestinationOption = { destination: Destination; name: string };

/** /api/destinations のプロバイダ別エントリ。片方失敗しても他方を返せるよう error を持つ */
export type DestinationCatalogEntry = { provider: Provider; options: DestinationOption[]; error?: boolean };

export type Author = {
  handle: string;
  displayName: string;
  /** 絵文字解決済みの表示名（あれば UI は RichText inline で描画。docs/name-display-spec.md §4） */
  displayNameRich?: RichSegment[];
  avatarUrl?: string;
};

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
  cw?: string; // コンテンツ警告（あれば既定で折りたたみ。docs/cw-display-spec.md）
  media: Media[];
  linkCard?: LinkCard;
  quote?: Post; // 引用で埋め込まれた投稿（描画は1階層のみ。docs/quote-display-spec.md）
  quoteUnavailable?: boolean; // 引用先が取得不能（削除/ブロック/切り離し）。quote と排他
  url?: string; // Provider 上の permalink（BFF 生成。bsky/misskey のみ）
  stats: { replies: number; reposts: number; likes: number }; // likes=反応総数
  reactions?: Reaction[]; // 絵文字別内訳（Misskey のみ）
  visibility?: Visibility; // 任意（Misskey）
  localOnly?: boolean; // 任意（Misskey）
  channel?: { id: string; name: string }; // 任意（Misskey）。投稿が所属するチャンネル
  ref?: unknown; // プロバイダ固有の自己参照（bsky={uri,cid} / misskey=noteId）
  viewer?: { likeUri?: string; repostUri?: string }; // 自分が行った操作の記録 URI（Bluesky のトグル用）
  source: unknown; // 各SNSの生データ退避
};

export type TimelineResponse = { posts: Post[]; nextCursor: string | null };

/** 投稿リクエスト（ブラウザ → BFF）。画像は事前アップロード済みの opaque 参照 */
export type PostInputWire = {
  provider: Provider; // 投稿先（単一ターゲット）
  destination?: Destination; // 提出先（省略 = home）。provider との一致を BFF が検証（docs/compose-destination-spec.md §4.2）
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

/** Like 操作リクエスト（ブラウザ → BFF。Bluesky のみ。uri/cid は Post.ref） */
export type LikeRequest = { uri: string; cid: string };
/** Like 解除リクエスト（自分の like レコード URI） */
export type UnlikeRequest = { recordUri: string };
/** リポスト操作リクエスト（bsky ref={uri,cid} / misskey ref=noteId。BFF がプロバイダごとに解釈） */
export type RepostRequest = { provider: Provider; ref: unknown };
/** リポスト解除リクエスト（Bluesky のみ。自分の repost レコード URI） */
export type UnrepostRequest = { recordUri: string };
/** 作成した操作レコードの URI 応答（misskey renote は URI 無しのため任意） */
export type RecordUriResponse = { recordUri?: string };

/** ピッカー用のローカルカスタム絵文字（BFF がレジストリを compact 化して配信。ADR-0006 キャッシュ再利用） */
export type EmojiInfo = { name: string; url: string; aliases?: string[] };

/** リアクション操作リクエスト（ブラウザ → BFF）。reaction あり→付与/置換、なし→解除（docs/misskey-reaction-action-spec.md） */
export type ReactionRequest = { provider: Provider; postId: string; reaction?: string };
export type ReactionResponse = { reaction?: string };

/** プロバイダの compose 設定（カウンタの単位と上限） */
export type ComposeConfig = {
  charLimit: number;
  unit: 'grapheme' | 'char';
};

export type ProviderInfo = {
  provider: Provider;
  configured: boolean;
  /** 投稿設定。読み取り専用 Provider（nostr）は持たない（docs/nostr-integration-spec.md §5.3） */
  compose?: ComposeConfig;
};

export type Health = {
  ok: boolean;
  service: string;
  session: 'configured' | 'missing-secrets';
  time: string;
};
