# SNSクライアント 仕様書（MVP）

> 複数 SNS を1つにまとめる PWA クライアント（構想: Mastodon / Bluesky / mixi2）。
> 本ドキュメントは **MVP（Bluesky 対応）** の確定仕様と、将来フェーズの指針を定める。
> ※ mixi2 統合は当面対象外（API 非公開のため）。
> 作成: grilling セッション（全10問合意）に基づく。

---

## 1. 背景・目的

- 複数の SNS（まずは Bluesky、将来 Mastodon）をアプリ横断せず1画面で扱いたい。
- スマホから PWA として使いたい。
- Cloudflare Workers で自前運用（当面は **単一ユーザー**前提）。

## 2. スコープ

### MVP（Phase 1）— 確定
- **Bluesky** のホームタイムライン閲覧 ＋ 投稿。
- BFF 経由のシンプルで安全な読み書き。
- インストール可能・オフライン対応の PWA。

### 将来（指針、未確定詳細）
- **Phase 1.5:** Bluesky のメンション（`resolveHandle` による DID 解決）。
- **Phase 2:** Mastodon プロバイダ統合、カスタムフィード/リスト、プッシュ通知（Workers cron ＋ Web Push）、バックグラウンド同期投稿。
  - **Misskey 統合（misskey.io 閲覧＋投稿・統合タイムライン）**: [misskey-integration-spec.md](./misskey-integration-spec.md) に確定仕様（grilling 全16問合意、ADR-0004/0005）。
- **対象外（当面）:** mixi2 統合（API 非公開・招待制のため。将来再検討）。

### 非対象（MVP）
- 複数ユーザー対応、DM、通知 UI、リアルタイム（Firehose）ストリーミング。

---

## 3. アーキテクチャ

**単一 Worker** が ① 静的 SPA 配信（Workers Static Assets）と ② BFF（`/api/*`）を兼ねる。フロントと BFF は同一オリジン（CORS ゼロ）。

```
[ スマホ PWA (React SPA) ]
        │  same-origin fetch (Cookie: CF_Authorization)
        ▼
┌─────────────────────────────────────────────┐
│ Cloudflare Worker (単一)                      │
│  ┌───────────────┐   ┌───────────────────┐  │
│  │ Static Assets │   │ BFF /api/*         │  │
│  │ (Vite build)  │   │  - session 管理     │  │
│  └───────────────┘   │  - @atproto/api    │  │
│                      └─────────┬─────────┘  │
└────────────────────────────────┼────────────┘
        Cloudflare Access (Zero Trust) で保護   │
                                 ▼
                     Bluesky (bsky.social / AppView)
```

- **認証 (ブラウザ↔Worker):** Cloudflare Access（Zero Trust）。ポリシー例「Email = 自分（OTP）」。アプリ側に認証コード不要。
- **認証 (Worker↔Bluesky):** App Password を Workers **シークレット**（`BSKY_HANDLE` / `BSKY_APP_PASSWORD`）として保持。ブラウザには一切出さない。
- **セッション管理:** Worker 側で `createSession` → `accessJwt` をモジュールスコープにキャッシュ。401 時は `refreshSession` → 失敗なら App Password で再 `createSession`（セルフヒーリング）。

### 主要な設計決定（grilling 合意事項）
| # | 決定 | 採用 |
|---|---|---|
| 1 | MVP スコープ | Bluesky 閲覧＋投稿。Mastodon は将来、mixi2 は当面対象外 |
| 2 | Worker の役割 | BFF（サーバ側セッション） |
| 3 | 認証 | Cloudflare Access ＋ App Password シークレット |
| 4 | フロント技術 | React + Vite + TypeScript + vite-plugin-pwa |
| 5 | 抽象化 | 最小の Provider インターフェース＋統合 Post モデルを今導入 |
| 6 | 投稿機能 | テキスト(グラフェム)＋リンクfacets＋画像4枚(alt)＋リプライ＋引用＋CW/言語 |
| 7 | タイムライン | ホームのみ／無限スクロール＋プル更新＋60–90秒ポーリング「新着ピル」 |
| 8 | PWA | インストール＋オフライン起動＋直近TLオフライン閲覧 |
| 9 | デプロイ | 単一 Worker、手動 `wrangler deploy`、1リポジトリ |
| 10 | 耐障害性 | 指数バックオフ／直近キャッシュ／トークン自動回復／下書き保持 |

---

## 4. ドメインモデル（最小抽象）

```ts
type Provider = 'bluesky' | 'mastodon'; // mixi2 は当面対象外

type Media = { type: 'image'; url: string; alt?: string };

type Post = {
  id: string;                 // 内部ID
  provider: Provider;
  author: { handle: string; displayName: string; avatarUrl?: string };
  text: string;
  createdAt: string;          // ISO 8601
  media: Media[];
  stats: { replies: number; reposts: number; likes: number };
  source: unknown;            // 各SNSの生データ（bsky の uri/cid 等）退避用
};

type PostInput = {
  text: string;
  media?: { blob: Blob; alt?: string }[];   // 最大4枚
  replyTo?: Post;             // reply ref (root/parent) を source から生成
  quote?: Post;               // embed record
  contentWarning?: string;    // self-labels
  langs?: string[];
};

interface SocialProvider {
  getTimeline(cursor?: string): Promise<{ posts: Post[]; nextCursor?: string }>;
  createPost(input: PostInput): Promise<Post>;
}
```

- MVP は `BlueskyProvider` のみ実装。
- `source: unknown` に生データを逃がし、「全サービスの最小公倍数」に引きずられない設計。

## 5. BFF API サーフェス（プロバイダ非依存）

| Method | Path | 内容 |
|---|---|---|
| GET | `/api/timeline?cursor=` | ホーム TL（`{ posts, nextCursor }`） |
| POST | `/api/post` | 投稿（`PostInput` を受けて `Post` 返却） |
| POST | `/api/media` | 画像アップロード（`uploadBlob`、alt 付き） |
| GET | `/api/health` | 死活＋セッション状態（認証失敗検知用） |

- ブラウザは自前 `/api/*` のみ呼び出す薄い fetch クライアント。`@atproto/api` SDK は **Worker 側**で使用。

## 6. 画面・UX

- **タイムライン:** ホーム（フォロー中）。カーソル式無限スクロール。プルtoリフレッシュ＋手動更新。60–90秒の緩やかポーリングで **「新着 N 件」ピル**（タップで先頭ジャンプ、**自動挿入しない**＝スクロール位置保護）。
- **投稿ボックス:** グラフェムカウンタ（`Intl.Segmenter` 等で正確に计数）、リンク facets 自動検出、画像4枚（alt 入力）、リプライ／引用、CW/言語。メンションは Phase 1.5。
- **状態表示:** オフラインバナー、API エラーはトースト＋直近キャッシュ表示、投稿失敗時は下書きを保持しリトライボタン。

## 7. PWA

- `manifest`＋アイコン＋`display: standalone`＋theme-color（インストール可能）。
- Service Worker: アプリシェル precache、静的アセット runtime cache、**`/api` とナビゲーションは network-first**（Access ログイン画面をキャッシュしない）。
- 直近タイムライン JSON を Cache API に保存し、オフライン閲覧可能。
- プッシュ通知・バックグラウンド同期は Phase 2（iOS Safari の Background Sync 非対応も考慮）。

## 8. 耐障害性・エラーハンドリング

- ポーリング/リフレッシュ失敗 → **指数バックオフ**（連打・レート制限対策）。
- **直近成功レスポンスをキャッシュ**（メモリ＋Cache API）、失敗時はそれを表示＋トースト。
- トークン回復チェーン: `401 → refreshSession → createSession(App Password)`。
- App Password 無効化等で `createSession` 恒久失敗 → **「認証失敗」トーストを出しポーリング停止**（無限リトライしない）。
- 投稿失敗 → 下書き保持＋リトライ（自動再送キューは作らない）。

## 9. プロジェクト構成・デプロイ

```
repo/
├─ app/            # React + Vite SPA (フロント)
├─ worker/         # BFF (@atproto/api, session 管理)
├─ wrangler.jsonc  # assets + Worker 設定
└─ package.json
```

- ビルド: `vite build` → Worker の assets ディレクトリ → `wrangler deploy`（**手動**）。
- シークレット: `BSKY_HANDLE` / `BSKY_APP_PASSWORD`（`wrangler secret`）。
- Cloudflare Access アプリケーションを Worker ルートに紐づけ。

## 10. マイルストーン

1. **M1:** Worker スケルトン＋Static Assets 配信＋Access 保護＋ヘルスチェック。
2. **M2:** BFF セッション管理＋`/api/timeline`＋タイムライン UI（無限スクロール/プル更新/新着ピル）。
3. **M3:** 投稿（グラフェム/facets/画像4枚/リプライ/引用/CW）＋`/api/post`・`/api/media`。
4. **M4:** PWA 化（manifest/SW/オフライン閲覧）＋耐障害性仕上げ。
5. **Phase 1.5:** メンション。
6. **Phase 2:** Mastodon/mixi2 プロバイダ、カスタムフィード、プッシュ通知。

## 11. 前提・未決事項・リスク

- ✅ **ドメイン:** カスタムドメインは使用せず **`*.workers.dev`** で運用（HTTPS のため PWA インストール・Cloudflare Access とも動作）。
- ⚠️ Cloudflare Access ＋ PWA: SW がログイン画面をキャッシュしないようキャッシュ戦略に注意。
- ⚠️ Bluesky 側の仕様変更（年齢確認 `ageassurance` 等）の影響を受ける可能性。
- ⚠️ App Password ローテーション時の再設定オペレーションが必要。
- ℹ️ mixi2 は当面対象外。将来統合する場合は API 非公開のためプロキシ必須・実現性要調査。
