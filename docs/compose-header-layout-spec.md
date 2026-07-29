# Compose ヘッダーレイアウト 仕様書（アクションバーの折り返し規則・中央揃え・投稿先ラベルの明確化）

> 複数 SNS を1画面で扱う PWA クライアント（[sns-client-spec.md](./sns-client-spec.md)）における、
> **新規投稿（Compose）モーダルヘッダーのレイアウト修正**の確定仕様。
> ボタンの意図しない縦改行と窮屈な間隔を解消し、閉じたセレクトから Provider を識別できるようにする。
> 作成: grill-with-docs セッション（全6問合意）に基づく。
> 関連: [compose-destination-spec.md](./compose-destination-spec.md)（§5.1 を本仕様に従い改訂）/
> [deck-view-spec.md](./deck-view-spec.md)（帰属バッジ「{Provider} · {name}」慣例 §5）/
> [misskey-channel-display-spec.md](./misskey-channel-display-spec.md)（📺 チャンネル表記）。
> 用語は [CONTEXT.md](../CONTEXT.md) 参照。

---

## 1. 背景・目的

- 新規投稿モーダルのヘッダー（`.modal-head`）は「閉じる／投稿先セレクト／投稿」の3要素を
  `justify-content: space-between` で並べているが、子要素に `flex-shrink: 0` も `white-space: nowrap` も
  指定されていない。そのため横幅が足りなくなると（狭いモバイル、長いチャンネル名選択時）ボタンが縮み、
  日本語ラベルが1文字ずつ**縦に折り返す**。
  - 左の「閉じる」が縦3文字になる。
  - 右の「投稿」（ピル型ボタン）が縦2文字になり、ピル形状が崩れる。テキストの中央揃えも保証されていない。
- 3要素間に明示の `gap` が無く、狭い幅ではセレクトと左右ボタンが接近して窮屈に見える。
- セレクトの閉じた状態の表示名が `name` のみ（[compose-destination-spec.md](./compose-destination-spec.md) §5.1）
  のため、複数 Provider 構成で「ホーム」が選ばれていると **Bluesky のホームか Misskey のホームか識別できない**。
  Provider はドロップダウン展開時の optgroup 見出しでしか分からない。
- 本仕様は上記4点（ボタンの縦改行×2・窮屈さ・曖昧な表示名）を、ヘッダーの**折り返し規則**と
  **ラベル規則**を確定させることで一括して解消する。

## 2. スコープ

### 今回（確定）

- ヘッダー3要素の**折り返し規則**（ワイド: 1行形／480px 以下: 確定2行形）。
- ボタンの**改行禁止・縮小禁止・中央揃え・最小幅**。
- 要素間の**隙間**（列方向 12px・折り返し時の行方向 8px）。
- **投稿先ラベルの Provider プレフィックス**（ホームのみ。「{Provider} · {name}」慣例）と optgroup 廃止。
- 固定表示（reply/quote 時の `.target-fixed`）への同等の保護と、ホバーによる正式名表示。
- ボタンの**マイクロインタラクション**（ホバー・押下・フォーカス。`prefers-reduced-motion` 対応）。
- テスト: ラベル合成の jsdom 検証と既存テストの追従。レイアウトは手動確認チェックリスト（§7.2）。

### 対象外

- ヘッダー以外の Compose 要素（テキストエリア・ツールバー・画像プレビュー等）の変更。
- BFF の Destination カタログ形式の変更（ラベル合成はクライアント側。`name` フィールドは不変）。
- 候補の出自バッジ（フォロー中／お気に入りの区別表示。compose-destination-spec §2 の対象外を継承。
  本仕様の Provider プレフィックスは「どの SNS か」の識別であり、出自バッジとは別概念）。
- CSS レイアウトの自動テスト（jsdom では検証不能。ADR-0001 の E2E 非採用を継承）。

## 3. レイアウト（折り返し規則）

### 3.1 ワイド（1行形）

```
┌──────────────────────────────────────────────────────┐
│ 閉じる          [ Bluesky · ホーム ▾ ]           投稿 │  ← 1行・両端揃え・列方向 gap 12px
└──────────────────────────────────────────────────────┘
```

- `.modal-head` は `display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px`。
  （`align-items: center` により縦方向のズレを無くす。）
- 「閉じる」`.link-btn`: `flex: 0 0 auto; white-space: nowrap`。テキストリンクの見た目は維持。
- 「投稿」`.primary-btn`: `flex: 0 0 auto; white-space: nowrap; display: inline-flex; align-items: center;
  justify-content: center; min-width: 7em`。ピル型（`border-radius: 999px`）は維持。
  `min-width: 7em` は「投稿」↔「送信中…」切替時の横幅変化（ヘッダーのチラつき）を吸収する。
- セレクト `.target-select` / 固定表示 `.target-fixed`: `min-width: 0; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis`。長いチャンネル名はセレクト内部で省略され、
  デスクトップでもボタンを圧迫しない。

### 3.2 ナロー（`max-width: 480px`・確定2行形）

```
┌────────────────────────────────┐
│ 閉じる                    投稿 │  ← 1行目: アクションバー（space-between）
│ [ 📺 こども部チャンネル… ▾ ]   │  ← 2行目: セレクトが全幅（行方向 gap 8px）
└────────────────────────────────┘
```

- 実装はメディアクエリ内で `.target-select, .target-fixed` に `order: 3; flex: 1 1 100%` を付与するのみ。
  **DOM 変更は行わない**。
- 1行目: 「閉じる」…「投稿」が space-between で両端に配置されたアクションバー。主操作「投稿」は常に完全な形で表示される。
- 2行目: セレクト（または固定表示）が**全幅**。長いチャンネル名が最も広く表示できる位置に置かれる。
- ブラウザの自然折り返し（`flex-wrap` のみ）は採用しない。DOM 順（閉じる→セレクト→投稿）のままでは
  「投稿」ボタンが2行目に孤立する中間状態が生じるため、折り返し形は常にこの2行形に確定させる。
- 480px という値は「1行形が成立しなくなる幅」ではなく**表示形の切替点**として定める。
  481px と 480px で表示が意図どおり切替わることを §7.2 で確認する。

### 3.3 固定表示（reply/quote 時）

- reply/quote 中はセレクトの代わりに固定表示（`.target-fixed`。例「📺 某チャンネル へ投稿」
  「Bluesky に投稿」）が同じヘッダー位置に出る（compose-destination-spec §5.4）。
- 固定表示はセレクトと**同一の保護**（改行禁止・最小幅ゼロ・省略記号）を受ける。
- 省略が発生し得るため、`title` 属性に正式な宛先名を設定し、ホバーで確認できるようにする。
- ナローでは固定表示も `order: 3; flex: 1 1 100%` により2行目・全幅で表示される。
- 候補が1つのみでセレクタを非表示にする既存挙動は変更しない（compose-destination-spec §5.1）。
  このときヘッダーは「閉じる…投稿」の両端配置のみとなる。

## 4. 投稿先ラベル（Provider プレフィックス）

- ホーム候補の表示ラベルを「**{Provider} · {name}**」に変更する: `Bluesky · ホーム` / `Misskey · ホーム`。
  - 書式は帰属バッジ（[deck-view-spec.md](./deck-view-spec.md) §5、`app/src/lib/sourceLabels.ts`）と
    同一の既存慣例。利用者は「· 区切り＝Provider 付き表示」を1箇所で学習できる。
- チャンネル候補は `📺 {name}` のまま。理由:
  1. 📺 はアプリ全体の Misskey チャンネル識別子として確立済み（[misskey-channel-display-spec.md](./misskey-channel-display-spec.md)）。
  2. チャンネル名は候補中で最長のラベルであり、プレフィックス付与は切り詰め（§3.1 の省略）を悪化させる。
- `optgroup` による Provider 分组は**廃止**し、フラットな候補リストにする。
  クローズド状態の識別性はラベルが担う（optgroup 見出しはドロップダウン展開時にしか見えないため）。
- ラベルはクライアント側で `PROVIDER_LABEL`（`app/src/lib/sourceLabels.ts`）から
  レンダリング時に合成する。BFF のカタログ形式（`name` フィールド）は変更しない。
- カタログ読み込み中に現在選択チャンネルを一時表示するフォールバック（現行 `📺 {id}`）も同一規則に従う。
- 本項により [compose-destination-spec.md](./compose-destination-spec.md) §5.1 の
  「表示名は `name` のみ。出自バッジは付けない」は改訂される（§6 参照）。

## 5. マイクロインタラクション

FAB（新規投稿フロートボタン）が既に持つホバー浮上・押下縮小の触感言語を、ヘッダーのボタンにも適用する。

- **「閉じる」`.link-btn`**: ホバーで下線。`:focus-visible` でフォーカスリング
  （現状はキーボード操作時の視認指標が弱い）。
- **「投稿」`.primary-btn`**:
  - ホバーで浮上（影の強調）、押下で縮小 — FAB と同一のフィードバック。
  - `:focus-visible` でフォーカスリング。
  - 無効時（上限超過・本文空・送信中）は既存どおり `opacity: 0.5`。
- すべてのトランジションは既存の `@media (prefers-reduced-motion: reduce)` の対象として無効化可能にする。

## 6. 既存文書との関係

- **[compose-destination-spec.md](./compose-destination-spec.md) §5.1**: 本仕様に従い改訂する。
  optgroup 例をプレフィックス付きフラットリストに置換し、「表示名は `name` のみ。出自バッジは付けない」を
  削除、本仕様への参照を追加。§2 の「出自バッジ対象外」は本件と無関係のため据え置く。
- **[deck-view-spec.md](./deck-view-spec.md) §5 / `app/src/lib/sourceLabels.ts`**: 「{Provider} · {name}」書式の参照元。変更なし。
- **[misskey-channel-display-spec.md](./misskey-channel-display-spec.md)**: 📺 チャンネル表記の根拠。変更なし。
- **ADR-0001 / ADR-0002**: テスト方針（E2E 非採用・Compose は主要 UI としてテスト対象）を継承。
  本件は ADR を要しない（UI ラベルと CSS の変更は容易に巻き返せ、記録すべきトレードオフが無い）。
- **[CONTEXT.md](../CONTEXT.md)**: 変更なし（新規ドメイン用語なし。「Compose」「Destination」は定義済み、
  「ヘッダー」は UI 部品でありドメイン用語ではない）。

## 7. テストと検証

### 7.1 自動テスト（jsdom・Testing Library）

- **新規**: 両 Provider 構成時、候補に `Bluesky · ホーム` と `Misskey · ホーム` が現れ、
  `Misskey · ホーム` が選択値として機能すること。optgroup が存在しないこと。
- **新規**: 閉じたセレクトの表示値がプレフィックス付きラベルであること。
- **追従**: 既存の Destination テストでホーム候補を `'ホーム'` という名前で引く箇所を
  `'Misskey · ホーム'` 等に更新。チャンネル名（`📺 ゲーム部`）は不変のため大半のテストはそのまま。

### 7.2 手動確認チェックリスト（レイアウト）

CSS レイアウトは jsdom で検証できないため、実機・ブラウザ幅指定で以下を確認する。

- [ ] デスクトップ（≥481px）: 1行で「閉じる｜セレクト｜投稿」が隙間12px・両端揃え・縦中央で並ぶ。
- [ ] 320px: 確定2行形。1行目両端に閉じる・投稿、2行目に全幅セレクト。いずれのボタンにも縦改行なし。
- [ ] 長いチャンネル名を選択: ボタンを圧迫せず省略記号（…）で切詰め。ホバーで正式名が表示される。
- [ ] 481px と 480px の境界で、表示形が意図どおり切替わる。
- [ ] 返信時: 固定表示が同等に保護され、ナローでは2行目に全幅表示される。
- [ ] 投稿クリック: 「投稿」→「送信中…」切替時にヘッダーの横幅が変化しない。
- [ ] キーボード操作: 閉じる・投稿の両ボタンにフォーカスリングが表示される。
- [ ] OS の「視差効果を弱める」設定でトランジションが無効になる。

---

実装は本仕様確定後の別工程: `app/src/components/Compose.tsx`（ラベル合成・optgroup 廃止・title 属性）と
`app/src/styles.css`（ヘッダーの折り返し規則・触感）。
