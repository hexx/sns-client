# テスト coverage の境界：ビジネスロジック・主要UI・BFF契約を測り、sw/エントリ/ビルドスクリプトは測らない

「必要十分」の線引きとして、自明でない壊れ方をする箇所にテストを集中させる。

対象（＝十分とする範囲）:

1. **純粋/ビジネスロジック**：`graphemes`、`worker/bsky.ts` の `mapPost`/`extractMedia`/`buildPostRecord`、`worker/index.ts` の `isAuthError`、`app/api.ts` のエラー処理
2. **主要 UI コンポーネント**：`PostCard` / `Compose` / `Timeline`
3. **BFF のルーティング契約**：`worker/index.ts` の `fetch`（ステータスコード / エラーハンドリング / SPA フォールバック）と `App` の wiring 統合

意図的に測らないもの（ROI が低い）:

- `app/sw.ts`（Service Worker。テスト困難・tsconfig からも除外）
- `app/main.tsx`（エントリポイント、自明）
- `scripts/render-icons.mjs`（アイコンのラスタライズスクリプト）
- 型・定数のみのファイル（`shared/types.ts` / `constants.ts`）
- worker のエージェント orchestration（`createPost` の refetch/fallback、`getTimeline`、`uploadMedia`）。（モックした）エージェントを呼んで `buildPostRecord`/`mapPost` に繋ぐ薄い wrapper で、難しいロジック本体は個別に測試済み。`createPost` の fallback は「メディア URL 空→UI 側で除外」と graceful に縮退するため、未テストのリスクが小さい

ネットワーク本体（`AtpAgent`）は実 Bluesky に繋げず、モジュール境界でモックして検証する。

## Considered Options

- 純粋ロジックのみ — 却下：主要 UI・BFF 契約が抜け「十分」に届かない
- 全コード — 却下：sw / エントリ / ビルドスクリプトは ROI が低く過剰
