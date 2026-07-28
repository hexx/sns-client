# Worker ルータの Hono 移行 仕様書

## 目的・背景

`worker/src/index.ts`（390行）は手書きの if チェーンルータで、12 パス / 15 のメソッドハンドラ（`/api/*`）+ 静的アセットフォールバックをさばいている。移行の動機は次の 2 点に限定する。

- **(b) ボイラープレートの反復**: ルートごとに「`request.json().catch(() => null)` → 検証 → `run(label, provider, fn)` によるエラーマッピング」という同じ形が繰り返されている
- **(c) ルーティングの可読性**: `url.pathname === API.x && request.method === 'M'` の if チェーンが 390 行に並び、エンドポイント一覧が一目でわからない

**行数そのものは問題ではない。** 目的が行数だけなら、依存ゼロの「ルートテーブル配列」リファクタで足りる。本移行は (b)+(c) を解決するために Hono のルーティング・`onError`・`HTTPException` を採用する（判断の記録: [ADR-0012](adr/0012-hono-as-worker-router.md)）。

## 決定: フル Hono（節度ある範囲で）

- ルーティングは `app.get/post/put/delete(API.x, ...)`。パス定数は `shared/constants.ts` の `API.*` をそのまま使う
- JSON 応答は `c.json()`。成功ステータスは明示する（投稿系は `c.json(body, 201)`。旧 `run()` の `okStatus` 暗黙パラメータの廃止）
- エラーハンドリングは単一の `app.onError` に集約し、各ハンドラから try/catch と `run()` ラップを完全に除去する
- 静的アセットフォールバックは `app.notFound` で処理する
- `?provider=` を受けるルートの bsky/misskey 分岐は、現状どおりハンドラ内の inline if/else を維持する（2 provider で引数形状が異なるため、dispatch table 化はしない）

## onError 設計

### provider 文脈の受け渡し

Hono の `Variables` を `{ provider?: Provider }` と型付けする。各ハンドラは provider 関数（`bskyTimeline` / `misskeyTimeline` 等）を呼び出す直前に `c.set('provider', provider)` する。`onError` は `c.get('provider')` を読んで認証エラーの分岐に使う。provider 未セット（provider 非依存の処理）で例外が届いた場合は汎用 502 とし、セルフヒーリングは行わない（現行と同等）。

### 検証エラーは HTTPException

検証失敗は `throw new HTTPException(status, { message })` で表し、if-return 連鎖を廃止する。ハンドラは happy path だけを書く。`onError` が `HTTPException → c.json({ error: err.message }, err.status)` にマップし、レスポンスボディ形状（`{error: string}`）は現行と完全互換とする。

### マップ表（現行 `run()` と同型）

| 条件 | レスポンス |
|---|---|
| `HTTPException` | `c.json({ error: message }, status)` |
| `BskyAuthError` / `MisskeyAuthError`（認証未設定） | 503 `{ error: message }` |
| `MisskeyApiError` | `e.status` + `{ error: e.code ?? 'misskey-error' }` |
| `isAuthError(e)` かつ provider=bluesky | `resetSession()`（セルフヒーリング）+ 502 `{ error: 'auth-retry', provider }` |
| `isAuthError(e)` かつ provider=misskey | 401 `{ error: 'auth-failed', provider, permanent: true }` |
| その他 | `console.error` + 502 `{ error: 'Internal server error' }` |

`isAuthError` の定義（status 401 またはメッセージのパターンマッチ）は現行から変更しない。

## notFound の挙動（現行維持）

- `pathname.startsWith(API.prefix)`（`/api/*` 未マッチ） → 501 `{ error: 'not implemented', path }`
- それ以外 → `c.env.ASSETS.fetch(c.req.raw)`（SPA フォールバック。wrangler の `not_found_handling` 任せにせず Worker 側で明示処理する現状を踏襲）

## 変更範囲

| ファイル | 扱い |
|---|---|
| `worker/src/index.ts` | **全リライト**（Hono app、ルート群、`onError`、`notFound`。`export type Env` は維持） |
| `worker/src/index.test.ts` | **原則無変更**。`export default app` も `.fetch(request, env)` を持つため互換 |
| `worker/src/bsky.ts` / `misskey.ts` | **無変更**（エラークラス含む。`onError` が既存クラスを `instanceof` で捌く） |
| `shared/constants.ts` / `shared/types.ts` | **無変更** |
| `wrangler.jsonc` | **無変更**（`main: worker/src/index.ts`。default export が `fetch` を持てばよい） |
| `package.json` | `hono` を **dependencies** に追加（Worker バンドルに入るため devDependencies ではない） |

移行は単一コミットの一括リライトで行う。旧ルータと Hono の共存は (c) をむしろ悪化させるため、段階移行はしない。`index.test.ts`（615行・58 fetch）が HTTP 境界の契約（ステータス・ボディ形状）を検証する安全網となる。

## やらないこと

- **zod / Hono validator ミドルウェアの導入** — 手書き検証（`validateViews` / `validateDestination` / inline チェック）は維持し、ハンドラ内で `HTTPException` を投げる形に移すだけにする。zod は別依存・別トレードオフなので、必要になったら別途 ADR
- **dispatch table 化** — provider 分岐は inline if/else のまま
- **段階移行** — 一括リライト
- **テストの改修・整理** — 互換性の検証に使うだけ
- **`bsky.ts` / `misskey.ts` のリファクタ**

## 検証

- `npm run typecheck && npm run lint && npm test && npm run build` すべてグリーン
- ビルド後にバンドルサイズ差分を記録する。実測（wrangler deploy --dry-run、Total Upload）: **gzip +15.5 KiB**（204.47 → 219.97 KiB）/ 非圧縮 +67.6 KiB。見積り（Hono min ~14kB）と概ね一致

## 帰結

- `hono` 依存の追加とバンドルサイズ増（実測: gzip +15.5 KiB / 非圧縮 +67.6 KiB）。現状の Worker が小さいため相対インパクトは小さくないが、(b)+(c) の解決と引き換えに許容する
- 行数はほぼ不変（390 → 398 行）。目的は行数削減ではなくボイラープレート除去と可読性であり、各ハンドラが happy path のみになったことで達成された
- ハンドラは Hono 流儀（`c.json` / `HTTPException` / `c.set`）に書き換わり、手書きルータへの巻き戻しはリライトになる（[ADR-0012](adr/0012-hono-as-worker-router.md)）

## ドキュメント方針

- **ADR**: [0012-hono-as-worker-router.md](adr/0012-hono-as-worker-router.md) を作成する。フレームワーク採用は ADR 3条件（巻き戻し困難・文脈なしでは不可解・実在する trade-off）を満たす
- **CONTEXT.md**: 変更なし。Hono・onError・HTTPException はすべて実装詳細であり、ドメイン用語表の対象外
