# 投稿者名表示 仕様書（長い名前の縦伸び解消＋名前絵文字の解決）

> 複数 SNS を1画面で扱う PWA クライアント（[sns-client-spec.md](./sns-client-spec.md)）における、
> **投稿者名の表示改善**の確定仕様。カードヘッダーのレイアウト再編と、Misskey 名に含まれる
> カスタム絵文字ショートコードの画像解決を扱う。
> 作成: grilling セッション（全5問合意）に基づく。
> 関連: [ADR-0005](./adr/0005-unified-inline-richtext.md)（統一インラインリッチテキスト）/
> [ADR-0006](./adr/0006-misskey-local-emoji-resolution.md)（ローカル絵文字解決）/
> [misskey-channel-display-spec.md](./misskey-channel-display-spec.md)（チャンネルチップ）。
> 用語は [CONTEXT.md](../CONTEXT.md) 参照。

---

## 1. 背景・目的

- 「なんかいウェブ研究所【公式】応彩しずく:verified_blue:」のような長い表示名の投稿で、
  名前が**1文字ずつ折り返して縦に極端に伸びる**。
- 原因は2つ:
  1. `.card-head`（flex）で `.author` が `min-width: 0` により無限に縮む一方、兄弟要素の
     時刻・チャンネルチップ（`max-width: 12em`）・プロバイダバッジ（`max-width: 12em`）が
     非収縮（`flex: 0 0 auto`）で幅を占有し、360px のデッキカラムでは名前の欄が
     数十字px まで圧迫される。
  2. Misskey のユーザー名に含まれるカスタム絵文字ショートコード（`:verified_blue:`）が
     未解決のまま生テキストで表示され、名前をさらに長くしている（本文の MFM 絵文字は
     ADR-0006 で解決済みだが、投稿者名は対象外だった）。
- 名前は SNS におけるアイデンティティであり、**隠さずに全文を表示する**ことを大前提に、
  圧迫を解消して読みやすい折り返し幅を確保する。

## 2. スコープ

### 今回（確定）
- **カードヘッダーの2行化**（レイアウト再編）。
- **名前・ハンドル行の折り返し許容**（圧迫の解消）。クランプ・省略はしない。
- **フルネームのツールチップ表示**（ネイティブ `title`）。
- **Misskey 名のカスタム絵文字ショートコードを画像に解決**（`Author.displayNameRich` の新設）。
- 名前の出る**全箇所**への適用: メインカードヘッダー・引用カード・リポストバッジ。

### 対象外
- カスタムツールチップ（独自描画のポップオーバー）。
- 名前のクランプ / 省略オプション（方針として採用しない）。
- Bluesky 表示名の装飾解釈（ショートコードの慣習がないため。Unicode 絵文字はテキスト表示のまま）。

## 3. レイアウト（カードヘッダーの2行化）

現行の1行構成 `avatar | 名前+handle | 時刻 | チップ+バッジ` をやめ、以下に再編する:

```
1行目: [avatar] 名前・・・・・・・・・・・・・・時刻（右端）
2行目: [avatar] @handle  [チャンネルチップ] [プロバイダバッジ]
```

- 名前は1行目の残り幅全体を使用する。
- 時刻は短いため1行目を名前と共有する（右端固定）。
- チャンネルチップとプロバイダバッジは補足情報として2行目（handle の隣）へ移動する。
- avatar は2行にまたがって縦中央（現行の `align-items: center` を維持）。
- このレイアウトは `PostCard` 共通のため、**モバイルのカードにも自動的に適用される**。

### 折り返し規則
- 名前・handle の各行に `overflow-wrap: anywhere` を適用する。
  - 確保された幅の範囲で自然に折り返す。**行数の制限（line-clamp）は行わない**。
  - 「1文字ずつ縦に伸びる」のは圧迫が原因であり、幅が確保されれば本則で解消する。
- フルネームは `title` 属性でホバー時に表示する（デスクトップ前提）。

## 4. 名前の絵文字解決（Misskey）

### モデル拡張
`Author` に任意フィールドを追加する（shared/types.ts）:

```ts
export type Author = {
  handle: string;
  displayName: string;
  displayNameRich?: RichSegment[]; // 絵文字解決済みの表示名（あれば UI は RichText で描画）
  avatarUrl?: string;
};
```

- `displayName`（プレーンテキスト）は常設。`displayNameRich` はショートコードを含む場合のみ生成する。
- UI は `displayNameRich` があれば既存の `RichText` コンポーネントで描画し、なければ `displayName` をテキスト描画する（本文の `rich` と同じ優先度）。

### 解決手順（BFF: worker/src/misskey.ts）
1. `mapNote` が既に読み込んでいる絵文字レジストリ（ADR-0006 の TTL キャッシュ）を `authorOf` に渡す。
2. 名前（`u.name || u.username`）中の `:name:` トークンを走査し、レジストリにあれば
   `{ type: 'emoji', name, url }` セグメントへ、テキスト部を `{ type: 'text' }` セグメントへ変換する。
3. **レジストリ未収録のショートコードは生テキストのまま**セグメント化する（フォールバック）。
4. ショートコードを1つも含まない名前は `displayNameRich` を生成しない（`undefined` のまま）。
5. `repostedBy`（リポストバッジ）も同じ `authorOf` 経由のため自動的に解決される。

Bluesky は `displayName` のみ生成し、`displayNameRich` は常に `undefined`（現状維持）。

## 5. 適用箇所

| 箇所 | 現行 | 変更後 |
|---|---|---|
| メインカードヘッダー（`.card-head`） | 1行圧迫・生テキスト | 2行化・フル表示・絵文字解決 |
| 引用カード（`.quote-head`） | 小さな1行・生テキスト | フル表示・絵文字解決（コンパクトな書式は維持） |
| リポストバッジ（`.repostedBy`） | インラインテキスト・生テキスト | フル表示・絵文字解決 |

3箇所すべてで「隠さない・解決する」を統一適用する（grilling Q4: A 採用）。

## 6. 既存文書との関係

- [ADR-0005](./adr/0005-unified-inline-richtext.md): `displayNameRich` は統一 `RichSegment` を再利用する。本文以外への初適用例。
- [ADR-0006](./adr/0006-misskey-local-emoji-resolution.md): 絵文字レジストリのキャッシュ機構を再利用する（追加のキャッシュ層は不要）。
- [misskey-channel-display-spec.md](./misskey-channel-display-spec.md): チャンネルチップの表示ルールは不変。ヘッダー内の配置のみ2行目へ移動する。
- [deck-view-spec.md](./deck-view-spec.md): プロバイダバッジ（帰属表示）の表示ルールは不変。配置のみ2行目へ移動する。
