# Grill セッション状態: 投稿者のプロフィール表示

タスク: ユーザーの「そろそろ投稿者のプロフィールを見たい」を受け、**投稿者のプロフィール表示**機能の仕様を /grill-with-docs スキル（/grilling + /domain-modeling）でまとめる。

## ⚠️ 最重要: 前セッション（thread-view）の失敗と教訓（次の AI は必ず読むこと）
- 前 AI は Q1 承認の後、**Q2 以降を「自分の推奨＝確定」とみなして先走り**、仕様書・ADR・用語集まで書き上げた。これは時期尚早。
- ユーザーは明確に否定: 「『あなたの推奨どおりで良いです』とは言いましたが、残りの質問全部が推奨どおりで良いと言ったわけではありません。**Q2からもう一度**お願いします。」
- つまり **「あなたの推奨どおりで良いです」はそのとき問うていた1問のみに有効**。残りの質問すべてへの白紙委任ではない。必ず1問ずつ質問し、回答を待て。複数問を一度に聞くな。合意前に実装するな。
- 前 AI は compaction の自動継続通知のループに巻き込まれ、「待機」と「実装」を往復して空回りした。次の AI は**次の質問を提示して回答を待つだけ**にすること。自動通知を実装のゴーサインと解釈しない。

## 確定事実（コードベース確認済み。再確認してもよい）
- プロジェクト: SNS クライアント（Bluesky + Misskey + Nostr 読み取り専用）、React+Vite SPA + Cloudflare Worker BFF（Hono）、PWA
- **プロフィール表示機能は一切存在しない**（/api/profile 等のルート無し、UI 無し、モデル無し）
- `Author` は投稿に埋め込まれる軽量モデル: `{id, handle, displayName, displayNameRich?, avatarUrl?}`（shared/types.ts）
- アプリにルーター無し。ナビゲーション = デッキカラム + モバイル pager + オーバーレイ（Compose / View 編集 / Lightbox / Thread）のみ。Thread はオーバーレイパターン確立済み（docs/thread-view-spec.md）
- PostCard のクリック: カード本文クリックで Thread を開く。`NO_NAV_SELECTOR = 'button, a, .lightbox, .picker, .card-menu-wrap'` と `.quote-card` は貫通しない（thread-view-spec §6.1）。アバター・表示名・handle は現在クリック不可
- PostMenu（⋯）: 投稿者への block / mute あり（bsky/misskey のみ、nostr はメニュー自体なし）。自分の投稿は項目非表示（/api/me で判定）
- Provider のプロフィール取得能力:
  - Bluesky: `getProfile({actor})` → did, handle, displayName, description, avatar, banner, followersCount, followsCount, postsCount, createdAt, viewer（follow 状態等）
  - Misskey: `users/show`（userId）→ id, username, host, name, avatarUrl, bannerUrl, description, followersCount, followingCount, notesCount, isFollowing, isFollowed 等
  - Nostr: kind:0 メタデータ（name, display_name, about, picture, banner）。**カウントは無い**。取得はブラウザ直接（ADR-0014）。`shared/nostr.ts` に `Profile` 型・`loadProfiles`・`parseProfile` が既存（kind:0 の解決に使用中）
- 既存 API ルートは shared/constants.ts の `API` で一元管理（新ルート追加はここに足す）
- 通知（NotificationCard）の actor は Author。フォロー通知もある（bsky 'follow' / misskey 'follow'）
- テスト: 417/417 passed / lint clean / typecheck clean / build ok（thread-view 実装完了時点）
- .handoff/outbox.md: **thread-view の PR 作成がコードレビュー（ocr）の LLM 未設定で中断中**（別タスク。ユーザーに確認済みの保留事項）
- スキル: /home/pi/.pi/agent/skills/grill-with-docs/SKILL.md（/grilling を実行し /domain-modeling を使う）
  - grilling: 1問ずつ質問・必ず推奨を添える・事実はコードベースで調べる・合意前に実装しない
  - domain-modeling: 確定した用語は CONTEXT.md にその場で反映。ADR は3条件（覆しにくい／文脈なしでは意外／本物のトレードオフ）を満たすときのみ

## 未確定の決定ツリー（Q は1問ずつ。推奨を添えてユーザーに問う）
- ~~Q1 スコープ~~ → 確定（A 概要＋投稿一覧）
- ~~Q2 ナビゲーション~~ → 確定（A オーバーレイ）
- ~~Q3 入口~~ → 確定（A アバター＋表示名＋handle）
- ~~Q4 データ取得~~ → 確定（A /api/profile 新設＋nostr ブラウザ直接）
- ~~Q5 応答モデル~~ → 確定（A Profile 型＋description リッチ化）
- ~~Q6 操作~~ → 確定（A follow/unfollow を含める）
- ~~Q7 投稿一覧~~ → 確定（A 投稿＋リポスト・PostCard 再利用）
- ~~Q8 nostr~~ → 確定（A MVP に含める）
- ~~Q9 自分のプロフィール~~ → 確定（A 自分も開ける）
- ~~Q10 取得不能~~ → 確定（A プレースホルダ）
- ~~Q11 オーバーレイ内遷移~~ → 確定（A 置換）
- ~~Q12 一覧 API 形状~~ → 確定（A 別ルート）

## ドキュメント（作成済み）
- `docs/profile-view-spec.md` — 確定版作成済み（Q1〜Q12 の決定を反映。§1 に「投稿一覧の View/Source 化はしない」将来の再審メモを明記）
- ADR 評価: **新規 ADR は作らない**（/api/profile＋nostr 直接は ADR-0014/0017 の踏襲、オーバーレイは Thread と同判断、follow は like/repost と同型。3条件を満たすもの無し）
- docs/README.md 索引に profile-view-spec.md を追加済み
- CONTEXT.md: Profile 項・follow 項追加、Author 項 sharpen 済み

## 検証状態
- **実装完了・全検証パス**: テスト 565/565 passed（22 ファイル）/ lint（oxlint --deny-warnings）clean / typecheck（worker+app）clean / build（vite + wrangler）ok

## 実装内容（docs/profile-view-spec.md 準拠）
- shared/types.ts: Profile / FollowRequest / UnfollowRequest / FollowResponse 追加。constants.ts: profile / profilePosts / follow ルート追加
- worker/bsky.ts: mapProfile・getProfile（取得不能→null→404）・mapAuthorFeedItem（reasonRepost→repostedBy）・getProfilePosts（posts_no_replies）・followActor/unfollowActor
- worker/misskey.ts: MkUser 拡張・mapProfile（descriptionRich は mfmToRich＋カスタム絵文字）・getProfile（users/show）・getProfilePosts（users/notes）・followUser/unfollowUser（following API）
- worker/index.ts: GET /api/profile（nostr 400・bsky null→404・misskey 404 引継ぎ）・GET /api/profile/posts・POST/DELETE /api/follow
- shared/nostr.ts: parseProfile に about/banner・getProfile（kind:0）・getProfilePosts（kind:1+6、1バッチ）
- app: api.ts 拡張・lib/profile.ts（BFF/ブラウザ直接のルーティング）・ProfileView.tsx（新規。概要＋一覧・follow 楽観更新・置換・自分判定・取得不能・無限スクロール）・PostCard/QuoteCard/NotificationCard 入口 button 化・ThreadView/TimelineCore/NotificationsView/Deck/MobilePager/App 配線・styles.css
- オーバーレイの重なり: プロフィールから Thread/Compose を開いたらプロフィールを閉じる（§8.2 追記。スタックしない方針）
- テスト追加: bsky/misskey mapProfile・index ルート・nostr parseProfile/getProfile/getProfilePosts・PostCard 入口・NotificationCard actor・ProfileView（新規 12 件）

## 残タスク
- 実機確認（wrangler dev での目視）はユーザー任せ。
- .handoff/outbox.md: thread-view の PR 作成がコードレビュー（ocr）の LLM 未設定で中断中（別タスク・保留）

## 確定済み決定（ユーザー承認済み）
- **Q1（スコープ）= A 概要＋投稿一覧** — 承認済み。「プロフィールを見たい」に「その人の投稿も見たい」が含まれる。プロフィールオーバーレイにヘッダー情報（アイコン・表示名・handle・自己紹介・フォロワー数等）＋そのユーザーの投稿一覧を表示する。取得は各 Provider 標準（bsky getAuthorFeed / Misskey users/notes）。
- **Q2（ナビゲーション）= A オーバーレイ** — 承認済み。Thread / Lightbox / Compose と同一パターン。ルーター導入せず、デッキカラム（Source 化）もしない。
- **Q3（入口）= A アバター＋表示名＋handle すべて** — 承認済み。対象: PostCard の投稿者行・リポスト行（「◯◯ がリポスト」の名前）、QuoteCard の著者行、NotificationCard の actor。すべて `<button>` 化して既存のカードクリック（Thread）と干渉させない。ThreadView は PostCard 再利用で自動的に含まれる。
- **Q4（データ取得）= A `/api/profile` 新設（BFF がプロバイダ差吸収）＋ nostr はブラウザ直接** — 承認済み。`GET /api/profile?provider=&id=` を追加。bsky `getProfile` / Misskey `users/show` を BFF が統一モデルに変換。nostr は `shared/nostr.ts` の kind:0 解決を再利用（ADR-0014 準拠、/api/thread と同じ分担パターン）。
- **Q5（応答モデル）= A 統一 Profile 型＋自己紹介もリッチ化（B）** — 承認済み。Profile = {provider, author（既存 Author 再利用）, description, descriptionRich?, bannerUrl?, stats?（投稿/フォロー/フォロワー）, url?, viewer?{following}}。Misskey のみ descriptionRich を mfmToRich で生成（カスタム絵文字解決込み）。bsky・nostr はプレーンテキスト。nostr は stats・banner 無し。
- **Q6（プロフィール内の操作）= A follow / unfollow を含める** — 承認済み。ヘッダーにフォロートグル（bsky/misskey のみ。nostr は非表示。自分のプロフィールでは非表示）。BFF ルート POST/DELETE /api/follow 新設（like/repost と同型）。block / mute は従来どおり PostMenu のみ（プロフィールに複製しない）。
- **Q7（投稿一覧）= A 投稿＋リポストを含む・PostCard 再利用・無限スクロール・自動更新なし** — 承認済み。bsky author feed はリポスト混在の自然な挙動のまま（BFF フィルタなし）。misskey はリノートも取得。スレッド入口と操作（reply/quote/reaction/like/repost）を有効。cursor ページング。新着ピル・自動更新は無し。
- **Q8（nostr の範囲）= A MVP に含める** — 承認済み。入口は他 Provider と同じ。概要 = アバター・表示名・handle（npub 短縮）・about・バナー（あれば。parseProfile に about/banner 解析を追加）。投稿一覧 = kind:1 照会（queryRelays 再利用、リポスト kind:6 も対象）。カウント・follow・nip05 は無し。
- **Q9（自分のプロフィール）= A 自分も開ける** — 承認済み。入口は他ユーザーと同じ。follow ボタンは /api/me 判定で非表示（PostMenu と同じ仕組み）。編集機能はスコープ外。nostr は「自分」概念が無いため対象外。
- **Q10（取得不能）= A オーバーレイを開きプレースホルダ表示** — 承認済み。「このユーザーは表示できません」＋閉じる手段のみ。ThreadNode.unavailable / quoteUnavailable と同一イディオム。
- **Q11（オーバーレイ内の遷移）= A 同一オーバーレイ内でプロフィールを置換** — 承認済み。リポスト行・quote card の著者行で置換して引き直し。履歴は積まない（閉じるは常に全体を閉じる。Thread Q14 と同一判断）。プロフィール本人への入口は反応しない。
- **Q12（投稿一覧の API 形状）= A 概要と一覧を別ルート** — 承認済み。`GET /api/profile`（概要）＋ `GET /api/profile/posts?cursor=`（`TimelineResponse` と同形状 `{posts, nextCursor}`）。nostr はブラウザ直接で同じ2系統。追加読み込みで概要を再取得しない。

## 現在の進行
- 実装完了・検証パス（565 tests / lint / typecheck / build）。ユーザーに完了報告済み。

## ユーザーとのやり取りの制約（厳守）
- ユーザーへの回答・質問はすべて日本語（AGENTS.md）
- すべての返答は「ファイルに書く → 日本語を確認する → ファイルを読み込む → 読み込んだ内容を**そのまま**返す」手順。言い換え・書き直し・翻訳（とくに英語化）は禁止。前セッションはこのドリフトで叱責された。
