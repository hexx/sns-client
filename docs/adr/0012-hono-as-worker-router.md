# BFF Worker のルータに Hono を採用する

`worker/src/index.ts` の手書き if チェーンルータ（12 パス / 15 ハンドラ）を Hono に移行する。動機は行数ではなく、ルートごとに繰り返す JSON パース・検証・エラーマッピングのボイラープレートと、if チェーンに埋もれたルーティングの可読性。Hono のルーティング・単一 `onError`・`HTTPException` でこれを解消する。詳細: [hono-migration-spec.md](../hono-migration-spec.md)。

## Considered Options

- 現状維持、または依存ゼロの「ルートテーブル配列」リファクタ — 却下：可読性は解決するが、ボイラープレートは自力ミニフレームワーク化で解決することになり、Hono が既製で提供するもの（`onError` 集約・`HTTPException`・型付き Context）を再発明する
- itty-router — 却下：ルータ専用で、エラーハンドリング集約や `HTTPException` 相当は自前構築になる。今回の主目的（ボイラープレート削減）に効く機能が Hono には既にある
- Hono をルータとしてだけ使い `run()` ヘルパーを残す — 却下：依存だけ増え、ボイラープレートは残る最悪の形

## Consequences

- `hono` 依存が追加され、バンドルは実測で gzip +15.5 KiB（非圧縮 +67.6 KiB）増える。ハンドラは Hono 流儀（`c.json` / `HTTPException` / `c.set('provider')`）に書き換わり、手書きルータへの巻き戻しはリライトを要する
- Hono の `onError` は `Error` インスタンスのみを受ける。プロバイダ関数は非 `Error`（例: `{status: 401}`）で reject し得る契約のため、catch-all ミドルウェアで非 `Error` を同じマッピングへ合流させている（`worker/src/index.ts` の `mapError`）
- zod / validator ミドルウェアは意図的に不採用。型付きバリデーションが欲しくなった場合は本 ADR を参照の上、別途 ADR を起こす（半年後に「zod 入れたら？」が再提案されるのを防ぐため）
