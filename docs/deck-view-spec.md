# デッキ UI 仕様書（Misskey × Bluesky 統合リストビューア）

> 複数 SNS を1画面で扱う PWA クライアント（[sns-client-spec.md](./sns-client-spec.md)）に、
> **リスト等をカラム単位で自由に混ぜて眺める TweetDeck 風デスクトップ UI** を追加する拡張の確定仕様。
> 作成: grilling セッション（全14問合意）に基づく。
> 関連 ADR: [ADR-0004](./adr/0004-view-as-n-sources-client-merge.md)。用語は [CONTEXT.md](../CONTEXT.md) 参照。

---

## 1. 背景・目的

- ホームタイムラインは既に統合されている。次は**リスト同士を混ぜて**見たい。
- TweetDeck のように、自分でカラム（= View）を構成し、複数カラムを1画面に並べて常時監視したい。
- デスクトップ専用設計（スマホの考慮はしない）。ただし既存のスマホ PWA 体験は壊さない。

## 2. スコープ

### 今回（確定）
- **デッキ UI**: 複数 View を横並びカラムで同時表示するデスクトップ用画面。
- **Source 種別の拡張**: Misskey `list` / `antenna`、Bluesky `list` / `feed` を Source として取得・合成可能にする（`home` は既存）。
- **利用者カスタム View**: UI からのカラム追加・編集・削除・並び替え。定義は **Cloudflare KV** に保存（ADR-0004 の「置き場所が KV に変わるだけ」を実現）。
- **カラム内インタラクション**: Bluesky Like / Repost、Misskey リアクション（既存ピッカー）/ Renote。

### 将来拡張（今回は対象外）
- Misskey ストリーミング（BFF WebSocket プロキシ経由のリアルタイム購読）。
- 返信・引用（新規投稿（compose）は [deck-compose-spec.md](./deck-compose-spec.md) で対応済み）。
- 複数アカウント（Misskey / Bluesky 各複数）。
- カラムごとのキーワードミュート・フィルタ。
- カラムのドラッグ&ドロップ並び替え。
- スマホ向けデッキ UI 最適化。

## 3. アーキテクチャ（既存踏襲）

- 単一 Cloudflare Worker が SPA 静的配信と BFF（`/api/*`）を同一オリジンで兼務する構成は不変。
- 認証情報はサーバ側シークレット（`BSKY_HANDLE` / `BSKY_APP_PASSWORD` / `MISSKEY_TOKEN` / `MISSKEY_INSTANCE_URL`）のまま。**ブラウザにトークンは出さない**。単一ユーザー前提、外部からは Cloudflare Access 保護。
- ドメインモデル不変: **View = 1つ以上の Source の集合**（`Source = { provider, kind, id? }`）。カラムは View の描画实例。クライアントが Source ごとに fetch・カーソル管理し、`createdAt` 順に合成して Timeline を描画する（ADR-0004）。

### Source 対応表

| Provider | kind | 取得元 | 備考 |
|---|---|---|---|
| Misskey | `home` | 既存 | — |
| Misskey | `list` | `users/lists/list` + `notes/user-list-timeline` | ユーザーリスト |
| Misskey | `antenna` | `antennas/list` + `antennas/notes` | — |
| Bluesky | `home` | 既存 | — |
| Bluesky | `list` | `app.bsky.graph.getLists`（自作）+ フォロー中リスト | curated list。`app.bsky.feed.getListFeed` で取得 |
| Bluesky | `feed` | saved feeds（`app.bsky.actor.getProfile` の `savedFeeds`）+ `app.bsky.feed.getFeed` | 発見フィードは対象外、saved のみ |

ピッカーでは種別バッジ（ホーム / リスト / アンテナ / フィード）で区別する。

### 更新モデル

- **全 Source ポーリング**。Misskey 15秒 / Bluesky 30秒（カラム内の Source 種別ごとに制御）。
- 新着の重複排除は投稿 ID ベース。
- 新着は自動挿入せず**ピルで通知**（既存 Timeline 方針）。クリックで取り込む。
- Misskey ストリーミングは後続マイルストーン（BFF が WS プロキシを持つ設計を要するため、今回とは分離）。

### View 定義の保存（KV）

- `GET /api/views` は KV の単一 JSON ドキュメント（View 配列）を読み、未設定時は Worker 内プリセットにフォールバック。
- 編集系 API（追加・更新・削除・並び替え）を BFF に追加し、KV に put する。
- 単一ユーザー・数カラム前提のため、正規化（D1）はしない。View の形（`{ id, name, sources: Source[] }` + 並び順）は ADR-0004 から不変。

## 4. アカウント

- Misskey: 1インスタンス・1アカウント（既定 `misskey.io`、`MISSKEY_INSTANCE_URL` で変更可）。
- Bluesky: 1アカウント。
- 既存のサーバ側シークレット構成をそのまま使う。追加の認証フローは不要。

## 5. 描画

- Misskey 本文は `mfm-js` 等で MFM を解釈して描画。カスタム絵文字はインスタンスの画像 URL に解決して表示（[ADR-0006](./adr/0006-misskey-local-emoji-resolution.md)）。CW はデフォルト折りたたみ、クリックで展開。
- Bluesky 本文は facets をリンク / メンション / タグに変換（[ADR-0005](./adr/0005-unified-inline-richtext.md)）。
- 添付画像はサムネイル表示（既存の Media / LinkCard 描画を再利用）。
- **帰属表示**: 各投稿にプラットフォームバッジ（Misskey / Bluesky）+ 由来ソース名（例:「技術リスト」）。マージ表示の必須情報。

## 6. 操作範囲

- 閲覧 + いいね系 + リポスト系まで:
  - Bluesky: Like / Repost。
  - Misskey: リアクション（既存のカスタム絵文字ピッカー、[reaction-action-spec](./misskey-reaction-action-spec.md)）/ Renote。
- 新規投稿（Compose）は [deck-compose-spec.md](./deck-compose-spec.md) を参照（デッキ UI からの起動を対応済み）。
- 返信・引用は対象外（deck-compose-spec でも引き続き非目標）。

## 7. UI（デスクトップ）

- **切替**: 画面幅 ≥1024px で起動時からデッキ UI を表示。<1024px では既存タブ UI（レスポンシブ切替、PWA 維持）。
- **レイアウト**: 固定幅（約360px）カラムを左から右へ並べ、画面に収まらない分は横スクロール。右端に「+ カラム追加」。
- **カラムごと独立スクロール**: 各カラムが自分の縦スクロールを持つ。過去投稿は無限スクロールで継ぎ足し（既存の Source ごとカーソル合成ページングを再利用）。
- **新着ピル**: カラム上部に「N 件の新着」ピル。
- **カラムヘッダー**: 名前、ソース数、設定（名前変更・ソース構成編集）・削除、並び替え用の左右矢印ボタン（DnD はしない）。
- **ソース構成編集**: プロバイダ・種別でグループ化したリストピッカーから複数選択。
- **部分障害耐性**: ある Source の取得が失敗しても、同じカラムの他 Source は描画を続け、カラムヘッダーにエラーチップを表示（ADR-0004 の方針）。

## 8. 非目標（v1）

複数アカウント／ストリーミング／返信・引用（新規投稿は [deck-compose-spec.md](./deck-compose-spec.md) で対応済み）／キーワードミュート／カラムの DnD 並び替え／スマホ向けデッキ最適化。

## 9. 既存文書との関係

- [sns-client-spec.md](./sns-client-spec.md): 親仕様。本仕様はそのデスクトップ UI 拡張。
- [misskey-integration-spec.md](./misskey-integration-spec.md): Misskey 描画・操作の詳細はこれを参照。本仕様は Source 種別（list / antenna）を追加する。
- [ADR-0004](./adr/0004-view-as-n-sources-client-merge.md): View = N Sources の機構と「将来 KV 等に変わるだけ」の予見を、本仕様が具体化する。
