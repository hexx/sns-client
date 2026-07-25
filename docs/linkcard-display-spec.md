# LinkCard（リンクプレビューカード）表示機能 仕様

タイムラインの投稿に付いた外部リンクのプレビューカード（Bluesky の `app.bsky.embed.external`）を、Twitter の summary card 風に描画する。**表示のみ**（投稿時の添付は対象外）。

## 用語（`CONTEXT.md` 反映済み）

- **LinkCard**: 投稿に添付された外部リンクのプレビューカード。URL・タイトル・説明・サムネイル画像を持つ。`Media`（画像添付）とは別概念。
  _Avoid_: Twitter card, OGP card, external embed, preview

## ドメインモデル（`shared/types.ts`）

```ts
export type LinkCard = { url: string; title: string; description: string; thumbUrl?: string };

export type Post = {
  // ...既存フィールド
  media: Media[];
  linkCard?: LinkCard; // 高々1つ。Media とは独立（Mastodon の media+card 共存に備える）
};
```

- `title` / `description` は空文字を許容する必須 string
- `thumbUrl` は省略可能（サムネイル無しカードがあり得る）
- `Media` との union にはしない。レンダリングが別物であることと、将来の Mastodon（`media_attachments` と `card` が共存）への備えのため

## BFF マッピング（`worker/src/bsky.ts`）

抽出元は以下の2つのみ:

1. `embed.$type === 'app.bsky.embed.external#view'`
   → `external.{uri,title,description,thumb}` を `linkCard` へ
2. `embed.$type === 'app.bsky.embed.recordWithMedia#view'` かつ `media` が external
   → 同様に抽出

対象外: `app.bsky.embed.record#view`（引用先が持つカード）。引用描画は未実装の別機能のため。

Bluesky では external は高々1つなので、`linkCard` フィールドへの正規化で衝突は起きない。

## レンダリング（`app/src/components/PostCard.tsx`）

- **配置**: 本文 → 画像メディア → LinkCard → stats
- **構造**: カード全体を `<a href={url} target="_blank" rel="noopener noreferrer">` で囲む（アプリ内遷移はしない）
- **サムネイル**: 上置き・横幅いっぱい、`loading="lazy"`、`alt=""`（装飾扱い）。`thumbUrl` 無しなら画像ブロックを非表示
- **タイトル**: 太字・最大2行クランプ（`-webkit-line-clamp`）
- **説明**: 最大3行クランプ、空なら非表示
- **URL 行**: `new URL(url).hostname` を表示（パース失敗時は `url` をそのまま）
- **フォールバック**: タイトル・説明とも空のカード（cardyb が情報を取れなかった場合など）は、ホスト名をタイトル扱いで表示し、カード自体は出す

## Service Worker（`app/src/sw.ts`）

- 画像 StaleWhileRevalidate キャッシュの対象オリジンに `cardyb.bsky.app` を追加
  （Bluesky 公式ドメインのため「信頼できない第三者オリジンはキャッシュしない」ポリシーに反しない。M4 のオフライン方針と整合）

## テスト（ADR-0001 / ADR-0002 準拠）

- `worker/src/bsky.test.ts`（`mapPost` の LinkCard 抽出）
  - `external#view` → `linkCard` にマッピング（title/description/thumb/uri）
  - `recordWithMedia#view` → media が external のとき `linkCard` を抽出（画像との共存ケース含む）
  - `record#view`（引用）→ `linkCard` は出さない（スコープ外を回帰防止で固定）
  - フィールド欠損（thumb 無し等）→ `thumbUrl` のみ省略
- `app/src/components/PostCard.test.tsx`（レンダリング）
  - カード描画: タイトル・説明・ホスト名・`href` / `target="_blank"` / `rel="noopener noreferrer"`
  - タイトル空 → ホスト名をタイトル表示
  - `linkCard` 無し → カード要素自体を描画しない
  - `thumbUrl` 無し → 画像を描画しない
- `sw.ts` は ADR-0002 により意図的にテストしない

## 対象外（明示）

- 投稿作成時の external embed 添付（Compose 拡張。サムネイル取得ロジックが別途必要）
- 引用ポストの描画、および引用先カードの表示
- ADR: 不要（「変更不要 × 文脈なしで驚き × 本当のトレードオフ」の3条件を同時に満たす判断が無いため）
