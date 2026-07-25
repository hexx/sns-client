# super-sns-client から sns-client へのリネーム（Worker/サブドメイン移行を伴う）

プロジェクト名・表示名を `super-sns-client` / `Super SNS Client` から `sns-client` / `SNS Client` へ統一する。Cloudflare Worker の `name`（＝ `*.workers.dev` のサブドメイン）も `sns-client` へ変更するため、既存 Worker の破棄と新 Worker への移行を伴う。

命名が冗長で愛着が持てなかったことが直接の動機。表示名だけ変えて機械名（特に URL）を残すと「中身は sns-client なのにアドレスバーだけ super-sns-client」という不整合が残るため、運用コストを負ってでも URL 含めて一律に刷新する。

## Considered Options

- 機械名（package/wrangler/health/ファイル名）のみリネームし、UI 表示名は `Super SNS Client` のまま — 却下：不整合が残り動機が満たされない
- 機械名＋表示名をリネームするが、wrangler name（サブドメイン）は据え置き — 却下：最も目につく URL に旧名が残り、Q1 で避けたかったちぐはぐさが再発する
- **機械名＋表示名＋サブドメインをすべて `sns-client` / `SNS Client` に統一（採用）**

## Consequences

- Cloudflare では Worker をリネームできず、`wrangler.jsonc` の `name` 変更は**別 Worker の新規作成**になる。移行は一度きりで、単一ユーザーの個人アプリなのでコストは小さい。
- 移行手順（この順序で実施する）:
  1. 名前を変更し `npm run deploy`（新 Worker `sns-client.<subdomain>.workers.dev` が作成される）
  2. 新 Worker にシークレット再設定: `wrangler secret put BSKY_HANDLE` / `wrangler secret put BSKY_APP_PASSWORD`
  3. Cloudflare Access のアプリケーションドメインを新ホスト名へ変更
  4. 新 URL で動作確認（`/api/health` / タイムライン / 投稿 / PWA インストール）
  5. スマホの旧 PWA ショートカットを削除し、新 URL でインストールし直し
  6. 旧 Worker を `wrangler delete`（旧 name `super-sns-client` 指定）で削除
- 旧 URL は旧 Worker 削除とともに失効する。単一ユーザー前提のため後方互換（リダイレクト等）は設けない。
- `package.json` の name 変更後は `package-lock.json` も `npm install` で再生成する。
