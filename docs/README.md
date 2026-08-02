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
- [thread-view-spec.md](thread-view-spec.md) — スレッド表示 仕様書（フォーカス投稿の祖先＋子孫をオーバーレイ表示）
- [profile-view-spec.md](profile-view-spec.md) — プロフィール表示 仕様書（投稿者の概要＋投稿一覧をオーバーレイ表示・フォロー操作）
- [block-mute-spec.md](block-mute-spec.md) — ユーザーのブロック・ミュート 仕様（サーバー側ネイティブ方式）
- [notifications-spec.md](notifications-spec.md) — 通知表示 仕様書（View 統合・既読管理・Thread 遷移）

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
- [0013](adr/0013-nostr-readonly-provider.md) — Nostr を読み取り専用 Provider として、BFF リクエスト単位 WebSocket で統合する
- [0014](adr/0014-nostr-browser-direct-transport.md) — Nostr の取得トランスポートを BFF 経由からブラウザ直接 WebSocket へ反転する
- [0015](adr/0015-quote-card-inline-expand-external-link.md) — 引用カードはインライン展開＋外部リンクとし、アプリ内スレッドビューは持たない（再審決着済み: カードクリックで引用先スレッドへ遷移）
- [0016](adr/0016-bsky-self-labels-as-cw.md) — Bluesky の self-labels を CW テキストとして解釈する
- [0017](adr/0017-thread-bff-flattened-depth.md) — スレッドは BFF が平坦化（DFS 順＋depth）して返し、Post に親子フィールドを持たせない
- [0018](adr/0018-server-side-native-block-mute.md) — ブロック・ミュートはサーバー側（Provider ネイティブ）方式とし、クライアント側フィルタは採用しない
- [0019](adr/0019-notification-unified-model.md) — 通知は統一 Notification モデルとし、bsky の対象投稿は BFF が補完取得する
- [0020](adr/0020-notifications-as-view-source.md) — 通知は View/Source 機構に載せ、通知同士の合成のみ許可する
