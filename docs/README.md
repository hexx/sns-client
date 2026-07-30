# docs 索引

仕様書と ADR（Architecture Decision Record）の一覧。README から個別にリンクされていないものもここに集約する。

## 全体仕様
- [sns-client-spec.md](sns-client-spec.md) — SNSクライアント 仕様書（MVP）
- [deck-view-spec.md](deck-view-spec.md) — デッキ UI 仕様書（Misskey × Bluesky 統合リストビューア）

## Misskey 統合
- [misskey-integration-spec.md](misskey-integration-spec.md) — Misskey 統合 仕様書（misskey.io 閲覧＋投稿）
- [misskey-reaction-action-spec.md](misskey-reaction-action-spec.md) — Misskey リアクション操作 仕様
- [misskey-channel-display-spec.md](misskey-channel-display-spec.md) — Misskey チャンネル投稿の識別表示 仕様
- [misskey-channel-source-spec.md](misskey-channel-source-spec.md) — Misskey チャンネルタイムラインの Source 化 仕様
- [mixi2-integration-spec.md](mixi2-integration-spec.md) — mixi2 統合 可行性とスコープ決定（対応しない決定）

## UI
- [mobile-paging-spec.md](mobile-paging-spec.md) — スマホ UI 仕様書（スワイプページングによる複数 View 閲覧）
- [unread-divider-spec.md](unread-divider-spec.md) — 新着境界仕様（取り込み後の未読範囲の可視化＋タブタップでの自動取り込み）
- [deck-compose-spec.md](deck-compose-spec.md) — デッキ UI からの Compose（新規投稿）仕様書
- [linkcard-display-spec.md](linkcard-display-spec.md) — LinkCard（リンクプレビューカード）表示機能 仕様
- [name-display-spec.md](name-display-spec.md) — 投稿者名表示 仕様書（長い名前の縦伸び解消＋名前絵文字の解決）
- [card-meta-row-spec.md](card-meta-row-spec.md) — カードメタ行 仕様書（ヘッダー3行化＋公開範囲バッジのアイコン化）

## PWA / アイコン / 運用
- [pwa-sw-update-fix-spec.md](pwa-sw-update-fix-spec.md) — PWA Service Worker 更新固定 修正仕様
- [app-icon-spec.md](app-icon-spec.md) — アプリアイコン（ファビコン / PWA アイコン）仕様
- [dependency-upgrade-2026-07.md](dependency-upgrade-2026-07.md) — 全依存ライブラリの最新化（2026-07）
- [hono-migration-spec.md](hono-migration-spec.md) — Worker ルータの Hono 移行 仕様書

## ADR（設計判断の記録）
- [0001](adr/0001-test-scope-no-e2e.md) — テスト範囲はユニット＋コンポーネントテストに限定し、E2E は採用しない
- [0002](adr/0002-test-coverage-boundary.md) — テスト coverage の境界：ビジネスロジック・主要UI・BFF契約を測り、sw/エントリ/ビルドスクリプトは測らない
- [0003](adr/0003-rename-to-sns-client.md) — super-sns-client から sns-client へのリネーム（Worker/サブドメイン移行を伴う）
- [0004](adr/0004-view-as-n-sources-client-merge.md) — 表示するタイムラインを「1つ以上の Source の集合（View）」として定義し、クライアント側で時系列合成する
- [0005](adr/0005-unified-inline-richtext.md) — リッチ本文はプロバイダ固有のまま越境させず、BFF で「統一インラインリッチテキスト」に変換して Post に載せる
- [0006](adr/0006-misskey-local-emoji-resolution.md) — Misskey ローカルカスタム絵文字の URL は BFF がインスタンスレジストリ（/api/emojis）から解決する
- [0007](adr/0007-misskey-reaction-action-design.md) — Misskey リアクション操作：楽観更新・単一 POST ルート・`ref` ターゲット
- [0008](adr/0008-app-icon-static-svg-assets.md) — アプリアイコン：SVG 単一ソース + コミット済み PNG、Provider ブランドカラーの不採用
- [0009](adr/0009-mixi2-out-of-scope.md) — mixi2 を Provider として統合しない（型上予約のみ）
- [0010](adr/0010-mobile-swipe-paging-all-mounted.md) — スマホ UI は全ページ常時マウントのスワイプページング
- [0011](adr/0011-threads-via-misskey-federation.md) — Threads は Provider 化せず Misskey 連合で吸収する
- [0012](adr/0012-hono-as-worker-router.md) — BFF Worker のルータに Hono を採用する
