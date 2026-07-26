# SNS Client

複数 SNS を1画面で扱う PWA クライアント。MVP は Bluesky（閲覧＋投稿）。
仕様: [docs/sns-client-spec.md](docs/sns-client-spec.md) ／ Misskey 統合: [docs/misskey-integration-spec.md](docs/misskey-integration-spec.md)

単一 Cloudflare Worker が **静的 SPA 配信** と **BFF (`/api/*`)** を兼ねます（同一オリジン）。

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

## Cloudflare Access（Zero Trust）で保護
アプリ側に認証コードは不要。ダッシュボードで設定:

1. Zero Trust → **Access** → **Applications** → **Add an application** (Self-hosted)
2. Application domain に Worker の `*.workers.dev` ホスト名を指定
3. **Add a policy** → Action: Allow, Include: **Emails** = 自分のメール
   （認証方式は One-time PIN を有効化）
4. 保存。以降、該当ホストへのアクセスは Access の OTP ログインで保護される

> ⚠️ PWA の Service Worker が Access ログイン画面をキャッシュしないよう、
> ナビゲーションは network-first にする（M4 で対応）。

## 構成
```
app/      React + Vite SPA (フロント)
worker/   BFF (@atproto/api, session 管理)
wrangler.jsonc  assets(run_worker_first) + Worker 設定
```

## マイルストーン
- [x] **M1** Worker スケルトン＋Static Assets＋`/api/health`
- [x] **M2** BFF セッション管理＋`/api/timeline`＋タイムライン UI（無限スクロール/プル更新/新着ピル）
- [x] **M3** 投稿（グラフェム/facets/画像/リプライ/引用/CW）
- [x] **M4** PWA 化＋オフライン＋耐障害性
- [x] **M5** Source 種別拡張（Misskey list/antenna・Bluesky list/feed の BFF 取得＋`/api/sources` カタログ）（[deck-view-spec](./docs/deck-view-spec.md)）
- [ ] **M6** カスタム View（KV 保存＋`PUT /api/views` 編集 API）
- [ ] **M7** デッキ UI（横並びカラム・レスポンシブ切替・ソースピッカー）
- [ ] **M8** カラム内操作（Bluesky Like/Repost・Misskey Renote）＋帰属表示

## PWA メモ
- カスタム Service Worker（`app/src/sw.ts`, injectManifest）:
  - アプリシェルは precache（オフライン起動）
  - ナビゲーションは **network-first（キャッシュしない）** → Cloudflare Access のログイン画面をキャッシュしない。オフライン時のみ precache シェルへ。
  - `/api/timeline` は network-first + キャッシュ（200 のみ）→ オフライン時に最後の取得成功分を表示
  - その他の `/api`（投稿/メディア）は NetworkOnly、画像は StaleWhileRevalidate
- アイコンのデザインソースは `app/public/icon.svg`（唯一のソース）。PNG は `npm run icons`（`scripts/render-icons.mjs`）で再生成してコミットする。ビルドはアイコンに触れない。仕様: [docs/app-icon-spec.md](docs/app-icon-spec.md)
- スマホでは HTTPS（`*.workers.dev`）でアクセスし「ホーム画面に追加」でインストール。
