# CW（コンテンツ警告）表示機能 仕様

読み取り側の CW をドメインモデルに新設し、トップレベル投稿と引用カードの両方で折りたたみ表示する。書き込み側（`PostInputWire.contentWarning`）は既存のまま。Bluesky の self-labels を CW として解釈する判断は [ADR-0016](./adr/0016-bsky-self-labels-as-cw.md) を参照。

## 用語（`CONTEXT.md` 既存）

- **CW（content warning）**: 投稿に付けるコンテンツ警告。閲覧前に内容を伏せる。

## ドメインモデル（`shared/types.ts`）

```ts
export type Post = {
  // ...既存フィールド
  cw?: string; // コンテンツ警告テキスト（あれば既定で折りたたみ）
};
```

## BFF 映射

| Provider | 映射元 | 規則 |
|---|---|---|
| Misskey | `note.cw`（`string \| null`） | null / 空文字でなければ `Post.cw` に設定 |
| Bluesky | `postView.labels`（self-labels） | `values[].val` を `, ` 連結して `Post.cw` に設定。値はそのまま（変換表なし、ADR-0016）。ラベル無しなら設定しない |
| Nostr | — | 設定しない（NIP-36 `content-warning` タグの映射は将来の独立判断） |

- 書き込み側との対称性: bsky は `contentWarning → self-label 1個` で送信済み（`worker/src/bsky.ts`）であり、読み取り側でそれが折りたたまれる。
- 引用先投稿（`post.quote`）にも同じ規則で `cw` を設定する（bsky 内包 `post#view` の labels、misskey `basePost(note.renote)` の cw）。

## UI

### 折りたたみ対象

`post.cw` が設定された投稿（トップレベル・引用カードを問わない）は、**既定で折りたたみ**状態になる。

**折りたたみ時に隠すもの**: 本文（rich/text）・Media・LinkCard・内包する quote / quoteUnavailable 案内・reactions チップ・アクションバー以外の付加情報。

**折りたたみ時に残すもの**: 投稿者ヘッダ（avatar・表示名・handle）・CW ピル・投稿日時。

### CW ピル

- `cw` テキスト + トグルボタン「表示する」/「隠す」を1行で表示する。
- `cw` が空文字の場合（Misskey `cw: ""` は API 上あり得る）はピルテキストを「CW」とする。

### トグル

- カードごとのローカル state、セッション内のみ。永続化しない。新着ピル挿入等の再マウントで折りたたみに戻ることは許容する。
- 引用カード内の CW は**親投稿のトグルと独立**する。親が展開されていても、引用カード自身の CW は既定で伏せたまま。

### 引用カードとの相互作用（quote-display-spec.md §UI と連動）

- 引用カードに `cw` がある場合、CW 折りたたみが quote card の通常/展開より優先される（まず「表示する」で内容を出し、その後は截断なしの全文表示）。
- 親投稿に `cw` がある場合、内包する quote card も含めて全体が伏せられる（「隠すもの」に内包 quote を含むため）。

## 対象外

- **bsky ラベルのモデレーション的扱い**（成人コンテンツフィルタ等）: 本仕様はラベルを CW 折りたたみとして表示するのみ。フィルタリング（表示自体を抑制する）は別機能。将来その必要が出た場合、`Post.cw` への映射を再審する（ADR-0016 Consequences）。
- **ラベル値の人間可読化**（`porn` →「成人向け」等）: MVP では値をそのまま表示。
- **Nostr NIP-36**: `content-warning` タグ（reason 任意）の映射は将来の独立判断。
- **CW の書き込み UI 強化**: 既存の Compose の CW 入力（`contentWarning`）をそのまま使う。

## テスト（ADR-0001 / ADR-0002 準拠）

- **worker unit**（`misskey.test.ts`）: `note.cw` あり/なし/空文字の映射。引用先ノートの cw 映射。
- **worker unit**（`bsky.test.ts`）: self-labels 単一/複数（`, ` 連結）/無しの映射。内包 post#view の labels 映射。
- **component**（`PostCard.test.tsx`）: 折りたたみ既定状態（本文・Media・LinkCard・quote・reactions が非表示、ヘッダと CW ピルは表示）、「表示する」/「隠す」トグル、空 cw の「CW」表示、引用カード内 CW の独立トグル、CW 展開後の本文が截断なしであること。
