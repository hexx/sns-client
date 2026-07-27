# SNS Client

複数 SNS を1画面の**デッキ**で統合して閲覧・投稿できる PWA クライアント。Bluesky と Misskey に対応し、SNS ごとの差異を吸収した統一モデルで投稿を扱います。
仕様: [docs/sns-client-spec.md](docs/sns-client-spec.md) ／ Misskey 統合: [docs/misskey-integration-spec.md](docs/misskey-integration-spec.md) ／ mixi2: [対応しない決定](docs/mixi2-integration-spec.md)（型上予約のみ）
仕様・ADR の全一覧は [docs/README.md](docs/README.md)。

単一 Cloudflare Worker が **静的 SPA 配信** と **BFF (`/api/*`)** を兼ねます（同一オリジン）。

## 機能
- **デッキ UI**: 複数カラムを横並びにし、Source（home / Bluesky の feed・list / Misskey の list・antenna・channel 等）を自由に割り当てて1画面で統合閲覧（[deck-view-spec](docs/deck-view-spec.md)）。
- **カスタム View**: Source の組み合わせを View として KV に保存・編集（`PUT /api/views`）。
- **Compose**: 新規投稿。本文・CW・画像（Media）・リプライ・引用、投稿先 Provider の選択に対応（[deck-compose-spec](docs/deck-compose-spec.md)）。
- **PWA / オフライン**: アプリシェルの precache、タイムラインの network-first キャッシュでオフライン起動・最終取得成功分の表示。

### Provider × 機能
| 機能 | Bluesky | Misskey |
|---|---|---|
| タイムライン閲覧・デッキ統合 | ○ | ○ |
| Compose（本文/CW/Media/リプライ/引用） | ○ | ○ |
| Like（単一カウンタ） | ○ | — |
| Repost / Renote | ○ | ○ |
| 絵文字リアクション（カスタム絵文字含む）（[仕様](docs/misskey-reaction-action-spec.md)） | — | ○ |
| チャンネル表示 / チャンネル Source（[表示](docs/misskey-channel-display-spec.md) / [Source 化](docs/misskey-channel-source-spec.md)） | — | ○ |

共通: LinkCard（[仕様](docs/linkcard-display-spec.md)）・grapheme 単位の投稿長・カスタム絵文字の画像解決・帰属バッジ。

## 前提
- Node 20+ / npm
- Cloudflare アカウント（Workers / Zero Trust）

## セットアップ

```bash
npm install
```

### 1. シークレット設定（Bluesky / Misskey 認証）
Bluesky の **App Password**（設定 → プライバシーとセキュリティ → アプリパスワード）と、
Misskey の **API トークン**（設定 → API → アクセストークン発行）を用意し、`.dev.vars`（ローカル開発用）に記入:

```bash
# .dev.vars (git 管理外)
BSKY_HANDLE=your-handle.bsky.social
BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
MISSKEY_INSTANCE_URL=https://misskey.io
MISSKEY_TOKEN=your-misskey-api-token
```

本番は `wrangler secret put BSKY_HANDLE` / `BSKY_APP_PASSWORD` / `MISSKEY_TOKEN`
（`MISSKEY_INSTANCE_URL` は `wrangler.jsonc` の vars に既定 `https://misskey.io`）。

カスタム View 用の KV namespace を作成し、`wrangler.jsonc` の `REPLACE_WITH_KV_NAMESPACE_ID` を置き換え:

```bash
npx wrangler kv namespace create VIEWS   # 出力の id を wrangler.jsonc へ
```

（ローカル dev はエミュレーションで動作。KV 未バインドでもプリセット View の配信のみ動作する）

### 2. ローカル開発
```bash
npm run dev:worker   # Worker (BFF) :8787
npm run dev:app      # Vite dev server :5173  (/api を 8787 へプロキシ)
```
http://localhost:5173 を開く。

### 3. デプロイ（手動）
```bash
npm run deploy       # vite build → wrangler deploy
```
デプロイ先: `https://sns-client.<your-subdomain>.workers.dev`

## 開発
```bash
npm test             # vitest（ユニット＋コンポーネントテスト）
npm run lint         # oxlint (--deny-warnings)
npm run typecheck    # tsc (worker / app)
```
テスト範囲・coverage の方針は [ADR-0001](docs/adr/0001-test-scope-no-e2e.md) / [ADR-0002](docs/adr/0002-test-coverage-boundary.md)。

## Cloudflare Access（Zero Trust）で保護
アプリ側に認証コードは不要。ダッシュボードで設定:

1. Zero Trust → **Access** → **Applications** → **Add an application** (Self-hosted)
2. Application domain に Worker の `*.workers.dev` ホスト名を指定
3. **Add a policy** → Action: Allow, Include: **Emails** = 自分のメール
   （認証方式は One-time PIN を有効化）
4. 保存。以降、該当ホストへのアクセスは Access の OTP ログインで保護される

> ⚠️ PWA の Service Worker が Access ログイン画面をキャッシュしないよう、
> ナビゲーションは network-first にする（[pwa-sw-update-fix-spec](docs/pwa-sw-update-fix-spec.md)）。

## 構成
```
app/      React + Vite SPA (フロント。カスタム Service Worker: app/src/sw.ts)
worker/   BFF（Bluesky: @atproto/api、Misskey: REST API へ dispatch。session 管理）
shared/   フロント・Worker・Service Worker で共有する型と API 定数
scripts/  アイコン生成（render-icons.mjs）
wrangler.jsonc  assets(run_worker_first) + Worker 設定
```

## PWA メモ
- カスタム Service Worker（`app/src/sw.ts`, injectManifest）:
  - アプリシェルは precache（オフライン起動）
  - ナビゲーションは **network-first（キャッシュしない）** → Cloudflare Access のログイン画面をキャッシュしない。オフライン時のみ precache シェルへ。
  - `/api/timeline` は network-first + キャッシュ（200 のみ）→ オフライン時に最後の取得成功分を表示
  - その他の `/api`（投稿/メディア）は NetworkOnly、画像は StaleWhileRevalidate
- アイコンのデザインソースは `app/public/icon.svg`（唯一のソース）。PNG は `npm run icons`（`scripts/render-icons.mjs`）で再生成してコミットする。ビルドはアイコンに触れない。仕様: [docs/app-icon-spec.md](docs/app-icon-spec.md)
- スマホでは HTTPS（`*.workers.dev`）でアクセスし「ホーム画面に追加」でインストール。
