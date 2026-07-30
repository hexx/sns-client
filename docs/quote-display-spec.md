# 引用表示（quote display）機能 仕様

タイムライン上の投稿に埋め込まれた引用（quote）を、インラインの引用カードとして表示する。Misskey は既存の引用renote映射を維持し、**Bluesky の読み取り側映射を新設**する。引用カードは表示専用で、インライン展開と Provider Web への外部リンクの2手段を持つ（[ADR-0015](./adr/0015-quote-card-inline-expand-external-link.md)）。CW の折りたたみは [cw-display-spec.md](./cw-display-spec.md) の管轄。

## 用語（`CONTEXT.md` 反映済み）

- **quote**: 既存の投稿を参照して自分の投稿に埋め込むこと（引用）。
- **quote card（引用カード）**: quote を表示するインラインカード。1階層・表示専用・通常/展開の2状態。

## ドメインモデル（`shared/types.ts`）

```ts
export type Post = {
  // ...既存フィールド
  quote?: Post;                 // 引用で埋め込まれた投稿（1階層のみ）
  quoteUnavailable?: boolean;   // 引用先が取得不能（削除・ブロック・切り離し）。quote と排他
  url?: string;                 // Provider 上の permalink（BFF 生成。任意）
};
```

- `quote` と `quoteUnavailable` の排他は BFF が保証する（同時設定しない）。
- `url` の生成対象は bsky / misskey のみ。nostr は設定しない（読み取り専用 Provider の permalink は将来の独立判断）。

## BFF 映射

### Bluesky（`worker/src/bsky.ts`、新設）

`postView.embed` を次の通り解釈する:

| embed の `$type` | 映射 |
|---|---|
| `app.bsky.embed.record#view` かつ record が `post#view` | `quote` = 内包投稿の Post 映射 |
| `app.bsky.embed.recordWithMedia#view` かつ record が `post#view` | `media` = `e.media` の画像、`quote` = 内包投稿（書き込み側の recordWithMedia 合成と対称） |
| record が `viewNotFound` / `viewBlocked` / `viewDetached` | `quoteUnavailable: true` |
| record が投稿以外（`app.bsky.graph.list`、`app.bsky.feed.generator` 等） | 何も映射しない（skip） |
| `recordWithMedia#view` で record が取得不能/投稿以外 | `media` は映射し、`quoteUnavailable: true`（または skip） |

内包 `post#view` の映射規則:

- `author` / `text` / `rich`（facets、既存の bsky-facets-spec.md に準拠）/ `createdAt` / `media` / `stats` / `ref`（`{uri, cid}`）/ `url` を映射する。
- **ネスト引用は捨てる**: 内包投稿の `embed` が更に record を持っていても `quote.quote` は作らない（既存モデルの「描画は1階層のみ」、Misskey 映射の `basePost` が renote を見ない挙動と一致）。
- 内包投稿の `selfLabels` は `cw` に映射する（cw-display-spec.md §映射）。

### Misskey（`worker/src/misskey.ts`、既存維持）

- 引用renote（本文付き、またはテキスト無しでもメディア付き）→ `post.quote = basePost(note.renote)`（既存、`mapNote`）。
- ネスト引用は既存通り捨てる（`basePost` は `renote` を参照しない）。
- Misskey は引用先ノートを常に完全なオブジェクトとして内包するため、`quoteUnavailable` を設定しない。

### permalink（`Post.url`）生成

| Provider | 生成規則 |
|---|---|
| bsky | `ref.uri`（`at://{did}/app.bsky.feed.post/{rkey}`）→ `https://bsky.app/profile/{did}/post/{rkey}` |
| misskey | `{instanceOf(env)}/notes/{noteId}`（インスタンスURLは worker 設定由来） |

トップレベル投稿・引用先の双方に設定する（UI の消費は当面引用カードのみ）。

## UI（`app/src/components/PostCard.tsx` の `QuoteCard`）

### 描画前提

- トップレベル投稿に `quote` があれば本文直下に quote card、`quoteUnavailable` であれば「元の投稿は表示できません」の案内行（グレイ、1行）を描画する。両方無ければ何も描画しない。

### 2状態

**通常（折りたたみ）**:
- ヘッダ（avatar・表示名・`@handle`）+ 本文（**CSS `line-clamp` で最大5行に截断**）+ 先頭画像サムネ（現行維持）。
- 右上に展開トグル（「もっと見る」）。
- `quote.cw` があれば、CW 折りたたみが優先（ヘッダ + CW ピル + 「表示する」のみ。cw-display-spec.md §UI）。

**展開**:
- 本文全文（截断なし）+ **Media 全枚**（既存 `MediaGrid` を再利用、Lightbox 対応）+ stats（返信・リポスト・いいね）+ 投稿日時 + **「外部で開く」アイコン**（`quote.url` を新規タブで開く、`rel="noopener noreferrer"`）。
- トグルは「閉じる」に戻る。
- CW 折りたたみを「表示する」で開いた本文は、截断なしの全表示とする（CW 展開 = 内容を見る意思の表明なので、二重の伏せは冗長）。

### 状態管理

- 展開トグル・CW トグルともカードごとのローカル state。セッション内のみで永続化しない（既存の unread と同じ割り切り）。

### 操作の禁止

- quote card から引用先投稿への返信・引用・リアクション・リポストは**一切できない**。アクションバーは描画しない。操作したい場合は「外部で開く」で Provider Web へ行ってもらう（[ADR-0015](./adr/0015-quote-card-inline-expand-external-link.md)）。

## 対象外

- **Nostr の引用**（NIP-18 `q` タグ / `nostr:note1...`）: nostr-integration-spec.md §4.8 の通りリンクセグメント表示に留める。参照イベントの追加 fetch（別リレー・削除済みで失敗しがち）を要するため。
- **投稿以外（list / feed generator）の embed 表示**: 別のドメイン概念（Source に関わる）であり本仕様の範囲外。
- **アプリ内スレッド/詳細ビュー**: 将来の独立機能。実装された場合、quote card クリックの挙動を「展開」から「遷移」へ再審する（ADR-0015 Consequences）。
- **CW 表示そのもの**: cw-display-spec.md を参照。

## テスト（ADR-0001 / ADR-0002 準拠）

- **worker unit**（`bsky.test.ts`）: record#view → quote 映射、recordWithMedia の media/quote 分離、viewNotFound/Blocked/Detached → quoteUnavailable、投稿以外 embed の skip、ネスト引用の切り捨て、url 生成（rkey 抽出）。
- **worker unit**（`misskey.test.ts`）: 既存の引用renote 映射に `url` 生成を追加検証。
- **component**（`PostCard.test.tsx`）: quote card の通常/展開トグル、5行截断クラス、展開時の stats・日時・外部リンク、quoteUnavailable の案内行、MediaGrid 再利用（Lightbox 起動）。
