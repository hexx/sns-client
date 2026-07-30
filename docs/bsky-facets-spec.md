# Bluesky facets の統一リッチテキスト変換 仕様

Bluesky の投稿本文に含まれる URL・メンション・ハッシュタグを、投稿レコードの `facets` から統一インラインリッチテキスト（`RichSegment[]`、ADR-0005）へ BFF で変換し、`Post.rich` に載せる。UI は既存の `RichText` で描画するため、本仕様で UI 変更は発生しない。

## 背景

現状 `worker/src/bsky.ts` の `mapPost` は `text` のみを詰め、`record.facets` を無視している。そのため Bluesky の投稿では本文内の URL がリンク化されず、Misskey（`mfmToRich` 済み）と描画品質が食い違っている。ADR-0005 の Consequences が「将来 Bluesky facets も同一スキーマに変換する」ことを明示しており、本仕様はその実行である。**新規 ADR は作成しない**（新たなトレードオフ分岐が無いため）。`CONTEXT.md` も変更なし（facet は Bluesky 固有の実装用語であり、用語集に載せない）。

## 対象範囲

- **対応する facet feature は3種**: `link` / `mention` / `tag`。未知の feature 型は当該 feature を無視し、その範囲をプレーンテキストとして残す。
- **適用経路**: `mapPost` を通るすべて（home / list / feed の各タイムライン、`createPost` 成功後の再取得）。加えて `createPost` の再取得失敗フォールバック経路でも、手元の `rt.facets` から同じ関数で `rich` を生成する。
- **対象外**: 引用（quote）埋め込み内の投稿（引用描画自体が未実装）、表示名（`displayNameRich`）の Bluesky 対応。

## ドメインモデル

変更なし。既存の `RichSegment`（`shared/types.ts`）をそのまま使う:

```ts
export type RichSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; url: string; text?: string }
  | { type: 'mention'; handle: string; url?: string }
  | { type: 'hashtag'; tag: string }
  | { type: 'emoji'; name: string; url?: string; char?: string }; // Bluesky では生成しない
```

## 変換ロジック（`worker/src/bsky.ts`）

純粋関数 `facetsToRich(text: string, facets: Facet[] | undefined): RichSegment[] | undefined` として切り出し、`mapPost` と `createPost` フォールバックの両方で使う。`facets` が無し・空・変換結果が単一の全プレーンテキストのみの場合は `undefined` を返し、`Post.rich` を載せない（`PostBody` のプレーンテキストフォールバックに委ねる）。

### バイトオフセットの扱い

facet の `index.byteStart` / `byteEnd` は **UTF-8 バイトオフセット**である（JS 文字列の UTF-16 インデックスではない）。絵文字・日本語などのマルチバイト文字で境界が壊れないよう、`TextEncoder` / `TextDecoder` 経由でスライスする。

### セグメント生成規則

| feature | 生成するセグメント |
|---|---|
| `link` | `{ type: 'link', url: feature.uri, text: 範囲内の表示テキスト }` |
| `mention` | `{ type: 'mention', handle: 表示テキストから先頭 '@' を除いたもの, url: 'https://bsky.app/profile/' + feature.did }` |
| `tag` | `{ type: 'hashtag', tag: feature.tag }` |

- feature の型絞り込みは `@atproto/api` の型ガード（`AppBskyRichtextFacet.isLink` / `isMention` / `isTag`）で行う。ガードは `$type` のみ検証するため、必須フィールド（link の `uri`、mention の `did`、tag の `tag`）は明示的にチェックし、欠落 facet は未知 feature と同様にプレーンテキストとして残す（壊れリンクを生成しない）。
- **mention は hydration しない**。DID → handle の解決（`getProfile`）は N+1 の API コストを招くため行わず、本文中の表示テキストを handle として採用する。`url` は DID から機械的に生成する。現 UI は mention の `url` を描画に使用しないが、将来のクリック対応に備えモデルには載せる。
- facet のかかっていない領域は `{ type: 'text' }` とする。隣接する text セグメントは連結して間引く（Misskey 側 `mergeText` と同じ方針）。

### ロバストネス方針（決してスローしない）

タイムライン描画パスは1件の不正データで全体を壊してはならない。以下の方針で防御する:

1. facets を `byteStart` 昇順でソートして処理する（入力順を信用しない）。
2. 範囲が不正な facet（負値、`byteStart > byteEnd`、テキストのバイト長超過、マルチバイト文字の途中に境界が落ちるケース）は**丸ごとスキップ**し、その領域はプレーンテキストとして残す。
3. 既に採用済みの範囲と重複する facet はスキップする（**先勝ち**: ソート順で先に採用されたものを優先）。
4. 変換中に例外が発生した場合は `undefined` を返し、プレーンテキスト描画へフォールバックする。

Misskey 側 `mfmToRich` の縮退方針（壊れてもプレーンテキスト）と同等の耐性水準に揃える。

## レンダリング

変更なし。`PostBody`（`app/src/components/PostCard.tsx`）は `post.rich` があれば `RichText` で描画済み。`link` は `<a target="_blank" rel="noopener noreferrer">` としてクリック可能。`mention` / `hashtag` はスタイル付き span（クリック不可）で、Misskey 由来の投稿と挙動が一致する。

## テスト（`worker/src/bsky.test.ts`）

`facetsToRich` の単体テストで以下をカバーする:

- 通常の link（`url` と表示テキスト `text` の双方が正しい）
- **マルチバイト境界**: 絵文字・日本語の直後に facet が来るケース（UTF-8 バイトオフセット処理の最重要検証）
- mention（表示テキスト由来 handle、`https://bsky.app/profile/{did}` の url）
- tag（`hashtag` セグメント）
- 重複 facet（先勝ちで後続をスキップ）
- 範囲超過・不正 facet（スキップしてテキストを残す、スローしない）
- facets 無し / 空 / 全プレーンのみ → `undefined`
