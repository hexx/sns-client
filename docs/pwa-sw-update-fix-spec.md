# PWA Service Worker 更新固定 修正仕様

> Android 端末で Misskey 投稿が表示されなくなる障害の確定仕様。
> 原因は Service Worker（SW）が新版本へ切り替わらず、端末が旧ビルドに永久固定されること。
> 本ドキュメントは**恒久修正**と、既に固定された端末の**救済 runbook** を定める。
> 作成: grilling セッション（全9問合意）に基づく。用語は [CONTEXT.md](../CONTEXT.md) 参照。

---

## 1. 背景・症状

「スマホ（Android）で Misskey のポストが見えない」という報告の調査結果。観測事実は以下のとおり。

| # | 観測 | 確認環境 |
|---|---|---|
| 1 | Misskey 投稿だけ表示されない（Bluesky は表示される） | Android PWA ＋ Android Chrome タブ（両方） |
| 2 | PC では Misskey 投稿も正常に表示される | PC ブラウザ |
| 3 | 古い投稿の追加読み込みで `TypeError: Failed to fetch` | Android |
| 4 | エラーバナーに `{provider}:` プレフィックスが**無い** | Android |

観測 4 が決定的である。現行ソース（`app/src/components/Timeline.tsx`）の Source エラーバナーは必ず `{s.source.provider}: {s.error}` を描画し、`misskey:` / `bluesky:` のプレフィックスを伴う。App 読込失敗・トーストも固定文言であり、生の `TypeError: Failed to fetch` をプレフィックス無しで出す箇所は現行コードに存在しない。

→ **Android 端末で動いているのは現行ソースではない（旧ビルド）** と結論づけられる。

## 2. 根本原因

**SW が新版本へ活性化せず、端末が Misskey 統合以前の旧ビルドに永久固定される。**

コードベースで確認した事実:

1. `app/vite.config.ts` は `strategies: 'injectManifest'` ＋ `registerType: 'autoUpdate'`。
2. `app/src/sw.ts` には **`self.skipWaiting()` も `clientsClaim()` も存在しない**。
3. `injectManifest` 方式では、vite-plugin-pwa は skipWaiting を自動注入しない（`generateSW` 方式と異なる）。開発者が自前で呼ぶ必要がある。
4. skipWaiting 無しでは、デプロイで新 SW が `installed` になっても **waiting のまま活性化しない**。古い SW を使うクライアント（PWA / タブ）が全て閉じるまで旧版が居座る。常に開かれがちな Android PWA では事実上**永久に旧ビルド**。
5. `registerType: 'autoUpdate'` が生成するクライアントコード（`registerSW.js`）は `controllerchange` イベントでページをリロードする。しかし `controllerchange` は新 SW が**活性化して初めて**発火する。skipWaiting 無しでは活性化しないため、autoUpdate は機能しない。

### 症状との対応

| 観測 | 機序 |
|---|---|
| PC で Misskey 表示 | PC は旧 SW が居座っておらず最新ビルドを取得 |
| Android で Misskey 非表示 | 端末が Misskey 統合以前（または中間版）の旧 SW precache で固定。旧アプリコードは Misskey 表示に対応しない |
| プレフィックス無し赤バナー | 旧ビルドのエラーバナー書式が現行（`{provider}:` 付き）と異なる＝旧コードが動いている直接的証拠 |
| `TypeError: Failed to fetch` | 旧ビルドの API/SW ルーティングが現行 BFF と噛み合わず、Misskey 要求のみネットワーク層で失敗 |

PC と Android で同じ Worker（同一オリジン・同一アセット）を叩いているのに差が出るのは、**端末ローカルの SW precache だけが異なる**ため。サーバ設定（`MISSKEY_TOKEN` 等）や Misskey API 自体は PC で動作していることから正常。

## 3. 修正設計（恒久）

### 3.1 SW の即時活性化

`app/src/sw.ts` に以下を追加する。

- **`install` イベントで `self.skipWaiting()`**: 新 SW が install 直後に waiting を飛ばして即活性化するようにする。
- **activate 時に `clientsClaim()`**（`workbox-core` 提供）: 活性化直後から、既に開いているクライアント（PWA / タブ）の制御を即座に取得する。

```ts
import { clientsClaim } from 'workbox-core';

self.skipWaiting();   // install 待ちをスキップして即活性化
clientsClaim();      // 既存クライアントの制御を即取得
```

> `self.skipWaiting()` はトップレベル（または `install` リスナ内）で呼ぶ。`clientsClaim()` はトップレベルで呼べば activate 時に効く。

### 3.2 autoUpdate との連動

skipWaiting ＋ clientsClaim により新 SW が即活性化すると `controllerchange` が発火し、`registerType: 'autoUpdate'` のクライアントコードが**ページを自動リロード**する。リロード後は最新 SW が制御し、precache された最新アプリバンドルが読まれる。これで「デプロイ → 全端末で即最新」が成立する。

### 3.3 動的キャッシュのバージョン bump

`sw.ts` の `VERSION`（現行 `'v1'`）を `'v2'` に上げる。activate ハンドラは `DYNAMIC_CACHES` に含まれない旧バージョンの動的キャッシュ（`api-timeline-*` / `api-meta-*` / `images-*`）を削除するロジックを持つため、バージョン bump で新 SW 活性化時に旧キャッシュが purge される。precache（workbox-precaching）は独自のリビジョン管理で旧エントリを自動削除するため追加対応不要。

### 3.4 sw.js 配信ヘッダの確認（検証項目）

ブラウザの SW 更新チェックは `sw.js` をネットワーク再検証する。Cloudflare Workers Static Assets は非ハッシュファイル（`sw.js` / `index.html`）に `Cache-Control: public, max-age=0, must-revalidate` を付与するため、更新検知は通る見込み。ただし本修正の実効性を保証するため、デプロイ後に `sw.js` のレスポンスヘッダに長期 `max-age` / `immutable` が付いていないことを確認する（付いていれば `_headers` 等で `no-cache` を明示する）。

## 4. stuck 端末救済 runbook（即時オペレーション）

### 4.1 原則: 恒久修正のデプロイで自己治癒する

`skipWaiting` 入り SW をデプロイすれば、ブラウザの SW 更新チェック（ナビゲーション時・定期）が新 `sw.js` を検知して install し、**新 SW 側が skipWaiting で即活性化**する。つまり既存の stuck 端末も、アプリを一度開き直すだけで最新ビルドへ乗り移る（`controllerchange` → 自動リロード）。原則として手動オペレーションは不要。

### 4.2 即時強制したい場合（更新チェックを待てないとき）

自分の Android 端末を今すぐ復旧させる手順。いずれか一つ:

- **A. サイトデータのリセット（推奨・最简单）**
  Android Chrome → 対象サイトを開く → アドレスバー左のサイト情報 →「データを削除してリセット」（または 設定 → サイトの設定 → 当該サイト → 削除）→ 再読込。SW・Cache Storage・Cookie が消え、次回アクセスで最新 SW が登録される。
  - ⚠️ Cloudflare Access の Cookie も消えるため、再ログイン（OTP）が必要。
- **B. PWA の再インストール**
  ホーム画面の PWA アイコンを削除 → Chrome でサイトを開き SW を unregister（または A を実施）→ 再度「ホーム画面に追加」。
- **C. Android リモート DevTools**
  PC と USB 接続 → `chrome://inspect` → 当該 PWA/タブを inspect → Application → Service Workers → **Unregister** → リロード。

### 4.3 復旧確認

復旧後、以下を満たすことを確認する（§5 受け入れ基準と同じ）:
- タイムラインに Misskey 投稿が Bluesky と混ざって表示される。
- 追加読み込みで `TypeError: Failed to fetch` が出ない。
- （エラー発生時は）バナーに `misskey:` / `bluesky:` のプレフィックスが付く＝現行ビルドの証拠。

## 5. 受け入れ基準（検証）

1. `sw.ts` に `self.skipWaiting()` ＋ `clientsClaim()` が入り、`VERSION` が bump されている。
2. デプロイ後、Android PWA を開くと `controllerchange` による自動リロードが発生し、最新ビルドに切り替わる。
3. Android（PWA・Chrome タブ両方）で Misskey 投稿が統合タイムラインに表示される。
4. 追加読み込み（無限スクロール）が Misskey / Bluesky 双方でエラーなく動作する。
5. `sw.js` のレスポンスに長期キャッシュヘッダが付いていない（§3.4）。

## 6. 対象外

- **更新通知 UI（`onNeedRefresh` トースト / リロード促し）**: 単一ユーザーの自前運用では過剰。skipWaiting 済みの autoUpdate（自動リロード）で十分なため採用しない。
- **iOS 固有の SW 更新挙動の追加対応**: 本障害は Android で報告。iOS も skipWaiting/clientsClaim で同様に改善するが、個別の検証・追加設計は今回は行わない。
- **SW の配信ヘッダ恒久設定（`_headers` 追加）**: §3.4 の確認結果、長期キャッシュが付いていない限り追加しない。

## 7. マイルストーン

1. **M1:** `sw.ts` 修正（`skipWaiting()` ＋ `clientsClaim()` 追加、`VERSION` を `v2` へ bump）＋ローカルで SW 活性化の動作確認。
2. **M2:** `wrangler deploy` で本番反映 ＋ 自分の Android 端末で救済検証（§4 / §5）。
3. **M3:** §3.4 の `sw.js` ヘッダ確認。必要なら `_headers` で `no-cache` 明示。runbook の実測結果を反映。

## 8. 前提・リスク

- ⚠️ skipWaiting は「全クライアントが即新 SW に切り替わる」ことを意味する。投稿 compose 中にリロードが挟まると下書きが失われる可能性がある（単一ユーザー・低頻度デプロイでは許容。必要なら将来 `onNeedRefresh` の手動更新へ切替）。
- ⚠️ SW 更新チェックはブラウザのタイミング（ナビゲーション時・最大24時間程度）に依存する。長期バックグラウンドの PWA は、次に開くまで旧 SW の場合がある（ apps を開き直せば治る）。
- ℹ️ 本修正は将来の全デプロイの伝播を直す。既に stuck した端末は §4 のとおり、原則デプロイ後の初回起動で自己治癒する。
