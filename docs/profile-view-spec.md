# プロフィール表示（profile view）機能 仕様

投稿カード等のアバター・表示名・handle をクリックすると、その投稿者（**Author**）のプロフィールを**オーバーレイ**で表示する。概要（自己紹介・統計・バナー等）と投稿一覧（その人の投稿＋リポスト）を持ち、Bluesky / Misskey は BFF（`/api/profile`・`/api/profile/posts`）が、Nostr はブラウザ直接解決がプロバイダ差を吸収し、いずれも同じ統一モデル（`Profile`・`TimelineResponse`）に合流する（[ADR-0014](./adr/0014-nostr-browser-direct-transport.md) 準拠。スレッド表示と同一の分担パターン）。用語は [CONTEXT.md](../CONTEXT.md) の **Author** / **Profile** / **follow** を参照。

## 1. スコープ

### 対象（MVP）
- **Bluesky・Misskey・Nostr** の投稿者に対するプロフィール表示（概要＋投稿一覧）。
- 入口: アバター・表示名・@handle のクリック（PostCard の投稿者行・リポスト行、QuoteCard の著者行、NotificationCard の actor）。
- follow / unfollow 操作（Bluesky / Misskey のみ。Nostr は読み取り専用のため操作なし。自分のプロフィールでは非表示）。
- 一覧内の既存操作（reply / like / repost / reaction。Nostr は閲覧のみ）とスレッド入口の再利用。
- 取得不能アカウント（削除・ブロック等）のプレースホルダ表示。

### 非対象
- プロフィール編集・アバター変更（このアプリに編集 API は無い）。
- フォロワー/フォロー中一覧、検索、nip05 バッジ（Nostr。DNS 検証をしない表示だけは誤解を生むため）。
- プロフィール新着のポーリング・自動挿入（オーバーレイは開いた時点のスナップショット。新着ピル機構は View ベースのため使わない）。
- 投稿一覧の View / Source 化（デッキカラムへの追加はしない。**将来の再審メモ**: 「このユーザーをカラムで常時ウォッチしたい」需要が出た場合は Source 種別（kind: `author`）として View に載せる案を再評価する。その際は本仕様の一覧部分を Source 実現に置き換え、概要はカラムヘッダーへ移す）。
- アプリ内ディープリンク・ブラウザ戻るボタンでの閉じ（ルーター非導入。[§2](#2-ナビゲーション)）。

## 2. ナビゲーション

- **オーバーレイ**で開く（Thread / Lightbox / Compose と同一パターン。ルーターは導入しない）。
  - デスクトップ: 背景を暗くした中央パネル（最大幅・上下スクロール）。
  - モバイル: 全画面オーバーレイ。
- 閉じる操作: Esc・背景クリック・閉じるボタン（Lightbox と同一流儀）。ブラウザの戻るボタンでは閉じない。
- **オーバーレイ内の遷移**: プロフィールを開いている最中に別のユーザーの入口（一覧内のリポスト行・quote card の著者行）を押すと、**同一オーバーレイ内でプロフィールを置き換えて引き直す**（履歴は積まない。スレッド内のフォーカス置換と同一判断）。閉じる操作は常に「オーバーレイ全体を閉じる」。
- **プロフィール本人への入口は反応しない**（一覧の投稿者は本人なので、置換の必要が無い。`author.id` の一致で判定）。

## 3. ドメインモデル（`shared/types.ts` 追加）

```ts
/** プロフィールの概要（/api/profile の応答。nostr はブラウザ直接解決が同じ形状を組み立てる） */
export type Profile = {
  provider: 'bluesky' | 'misskey' | 'nostr';
  author: Author;              // 既存の軽量モデルを再利用（id/handle/displayName/displayNameRich/avatarUrl）
  description?: string;        // 自己紹介（プレーンテキスト。フォールバック/検索用）
  descriptionRich?: RichSegment[]; // リッチ自己紹介（Misskey のみ。あれば UI はこちらを描画。name-display-spec と同じイディオム）
  bannerUrl?: string;          // bsky/misskey のみ（nostr は無し）
  stats?: { posts: number; following: number; followers: number }; // nostr は無し
  url?: string;                // Provider 上の permalink（BFF 生成。bsky=bsky.app/profile / misskey=ユーザーページ）
  viewer?: { following: boolean; followUri?: string }; // 自分がフォロー中か（bsky/misskey）。followUri は bsky のみ（解除用。Post.viewer.likeUri と同じイディオム）
};

/** フォロー操作リクエスト（ブラウザ → BFF。docs/profile-view-spec.md §6） */
export type FollowRequest = { provider: 'bluesky' | 'misskey'; actorId: string };
export type UnfollowRequest = { provider: 'bluesky' | 'misskey'; actorId: string; recordUri?: string }; // bsky は viewer.followUri を渡す。misskey は不要
export type FollowResponse = { recordUri?: string }; // bsky のみ（トグル状態の更新用）。misskey は URI 無し
```

設計原則:
- **Author 自体は拡張しない。** 投稿に埋め込まれる軽量モデルのまま維持し、詳細情報は `Profile` が担う（タイムライン応答の肥大化を防ぐ）。`Profile.author` は既存 `Author` をそのまま再利用する。
- `descriptionRich` は `displayNameRich` と同じイディオム（あれば RichText で描画、なければプレーンテキスト）。
- 投稿一覧の応答は既存 `TimelineResponse`（`{posts, nextCursor}`）をそのまま使う（新概念を増やさない）。

## 4. BFF（`GET /api/profile`、Bluesky / Misskey）

### 4.1 ルート（`worker/src/index.ts` 追加、`shared/constants.ts` の `API` に `profile: '/api/profile'` と `profilePosts: '/api/profile/posts'`）

```
GET /api/profile?provider=<provider>&id=<actorId>
```

- `id` は `Author.id`（bsky=DID / misskey=userId）。
- `provider` 検証は `/api/timeline` と同じ（`isProvider`）。**nostr は 400**（ブラウザ直接取得のため BFF 非対応。timeline と同じガード）。
- 認証失敗・プロバイダエラーのハンドリングは既存の `onError`（503/401/502）をそのまま使う。
- **Service Worker キャッシュ**: `/api/profile`・`/api/profile/posts` は **NetworkOnly**（鮮度が命。既存の「その他 /api（投稿/メディア）は NetworkOnly」方針に追従。`app/src/sw.ts`）。

### 4.2 Bluesky（`worker/src/bsky.ts` 追加）

`agent.getProfile({ actor: id })` を呼び、`ProfileViewDetailed` を映射する。

| ProfileViewDetailed | Profile |
|---|---|
| `did` / `handle` / `displayName` / `avatar` | `author`（既存の投稿者映射と同じ変換。displayName 無しは handle にフォールバック） |
| `description` | `description` |
| `banner` | `bannerUrl` |
| `postsCount` / `followsCount` / `followersCount` | `stats` |
| `viewer.following`（URI 文字列） | `viewer: { following: true, followUri: <uri> }`（無しなら `{ following: false }`） |
| — | `url: https://bsky.app/profile/<did>` |

- **取得失敗**（相手からブロックされている・アカウント消滅等）は既存のエラー処理で伝播し、クライアントは [§9](#9-取得不能アカウント) のプレースホルダを表示する。

### 4.3 Misskey（`worker/src/misskey.ts` 追加）

`mkApi<MkUser>(env, 'users/show', { userId: id })` を呼び、ユーザーオブジェクトを映射する。

| ユーザーオブジェクト | Profile |
|---|---|
| `id` / `username` / `host` / `name` / `avatarUrl` | `author`（既存 `authorOf` を再利用。リモートユーザーは `username@host`） |
| `description` | `description` ＋ `descriptionRich`（`mfmToRich(description, { ...registry, ...emojiMap(user.emojis) })`。カスタム絵文字解決込み） |
| `bannerUrl` | `bannerUrl` |
| `notesCount` / `followingCount` / `followersCount` | `stats` |
| `isFollowing` | `viewer: { following: <bool> }`（followUri は無し） |
| — | `url`（既存の permalink 生成と同じ方式。ローカルは `https://<instance>/@<username>`、リモートは `https://<host>/@<username>`） |

- **取得失敗**（`noSuchUser` 等）は既存のエラー処理で伝播し、クライアントはプレースホルダを表示する。

## 5. BFF（`GET /api/profile/posts`、Bluesky / Misskey）

```
GET /api/profile/posts?provider=<provider>&id=<actorId>&cursor=<opaque?>
```

応答は既存 `TimelineResponse`（`{posts, nextCursor}`）と同一形状。無限スクロールの追加読み込みは cursor をエコーする。

### 5.1 Bluesky（`worker/src/bsky.ts` 追加）

`agent.getAuthorFeed({ actor: id, limit: 30, cursor, filter: 'posts_no_replies' })` を呼ぶ。

- **`filter: 'posts_no_replies'`**: 投稿＋リポストのみ（リプライ除外。プロフィールの「Posts」タブと同等の挙動。Q7 決定の「投稿＋リポスト」に一致）。
- **リポストの映射（新規）**: 既存のタイムライン映射は `f.reason` を無視しているため、プロフィール一覧では `f.reason.$type === 'app.bsky.feed.defs#reasonRepost'` のとき `f.reason.by` を `repostedBy` に映射する（`Post.repostedBy` 表示は既存 PostCard が対応済み）。通常ノードは既存 `mapPost` を再利用。
- `cursor` はレスポンスの `cursor` をそのままエコー。無ければ `null`。

### 5.2 Misskey（`worker/src/misskey.ts` 追加）

`mkApi<MkNote[]>(env, 'users/notes', { userId: id, limit: 30, ...(cursor ? { untilId: cursor } : {}) })` を呼ぶ。

- `users/notes` は **`withRenotes` デフォルト true（リノート含む）・`withReplies` デフォルト false（リプライ含まず）** — Q7 決定の「投稿＋リポスト」にそのまま一致（明示指定は不要）。
- リノートは既存のタイムライン映射と同じ処理で `repostedBy` に映射（`note.renote` があるとき `authorOf(note.user, registry)`）。
- 絵文字解決・CW・channel 等の映射は既存 `mapNote` をそのまま再利用。
- ページングは `untilId` を `nextCursor` としてエコー。

## 6. BFF（follow / unfollow 操作、Bluesky / Misskey）

```
POST   /api/follow   { provider, actorId }                    → { recordUri? }
DELETE /api/follow   { provider, actorId, recordUri? }        → {}
```

- **Bluesky**: POST は `app.bsky.graph.follow` レコード作成（`agent.follow(did)`）、DELETE は `viewer.followUri`（クライアントが `recordUri` で渡す）のレコード削除。既存の like / unlike（`/api/likes`）と同じ流儀。
- **Misskey**: POST は `following/create { userId }`、DELETE は `following/delete { userId }`（recordUri は不要・無視）。
- `provider: 'nostr'` は 400（読み取り専用。ADR-0013）。
- エラーは既存 `onError` に集約。UI は楽観更新（like / repost と同じ流儀。失敗時ロールバック＋トースト）。

## 7. Nostr のブラウザ直接解決

Nostr は読み取り専用・ブラウザ直接 WebSocket（[ADR-0014](./adr/0014-nostr-browser-direct-transport.md)）のため BFF を経由せず、クライアントが既存の `queryRelays`（`shared/nostr.ts`）で解決し、**他 Provider と同じ `Profile` / `TimelineResponse` 形状を組み立てる**。UI は Provider 差を意識しない。

- **概要**: 既存の kind:0 解決（`loadProfiles` / `parseProfile`）を再利用。`parseProfile` に **`about`（自己紹介）と `banner` の解析を追加**する（NIP-01 のメタデータフィールド。現在は name / display_name / picture のみ）。
  - `author`: 既存 `toAuthor` を再利用（handle = npub 短縮形）。
  - `description`: about。`descriptionRich` は無し（プレーンテキスト）。
  - `stats`・`viewer`・`url`: **無し**（リレーに統計は無い。NIP-05 バッジ・外部 permalink も対象外）。
- **投稿一覧**: `queryRelays({ kinds: [1, 6], authors: [pubkey] })` で照会し、既存のタイムライン映射（`buildFeedPosts`。kind:6 のリポスト映射・自己リポストの重複排除）を再利用して `TimelineResponse` を組み立てる。
  - **ページング**: getTimeline と同じ `until`（created_at の unix 秒）を cursor として継続する（NIP-01 の until＋limit。リレーの標準機能）。
- **取得不能**: リレーに kind:0 が無い場合は `parseProfile` のフォールバック表示（handle のみ）。「削除」と「リレーに無い」は区別しない。
- **操作**: follow / reply / like / repost / reaction は一切表示しない（読み取り専用）。

## 8. UI

### 8.1 入口（`PostCard.tsx` / `QuoteCard.tsx` / `NotificationCard.tsx`）

- **アバター・表示名・@handle を `<button>` 化**し、クリックでプロフィールを開く（`onOpenProfile` ハンドラ。無指定時はクリック不可 — `onOpenThread` と同じ規約）。
  - `button, a` は既存の `NO_NAV_SELECTOR` に含まれるため、**カード本文クリック（Thread）・quote card 遷移と干渉しない**（貫通制御はそのまま機能する）。
  - 対象と著者:
    - PostCard の投稿者行（アバター・表示名・@handle）→ 投稿者
    - PostCard のリポスト行（「◯◯ がリポスト」の名前）→ リポストした人
    - QuoteCard の著者行（アバター・表示名・@handle）→ 引用元の投稿者
    - NotificationCard の actor（アバター・名前）→ 通知の主体
  - ThreadView は PostCard を再利用するため、スレッド内でも同じ入口が自動的に効く。
- **全 Provider（nostr 含む）で有効**（Q8 決定）。

### 8.2 オーバーレイ（新コンポーネント `ProfileView.tsx`）

- `modal-backdrop` / `modal` パターン（ThreadView と同一）。ヘッダー（閉じるボタン＋「プロフィール」＋帰属バッジ（Provider 名。`attribution badge` の流儀））＋スクロール本文。
- **ヘッダー部**（一覧と一緒にスクロール）:
  - バナー画像（`bannerUrl` があれば）。
  - 大きめアバター・表示名（`displayNameRich` があれば RichText）・@handle。
  - 自己紹介（`descriptionRich` があれば RichText、なければプレーンテキスト）。
  - カウント行: 投稿 / フォロー / フォロワー（`stats` があるときのみ。nostr は非表示）。
  - **follow ボタン**: 「フォロー」/「フォロー中」トグル（`viewer.following` で初期化。楽観更新）。
    - 表示条件: bsky / misskey のみ。**自分のプロフィールでは非表示**（`/api/me` の lazy キャッシュで判定。PostMenu の「自分の投稿か」と同じ機構）。
  - **↗ 外部リンク**（`url` があれば。別タブで Provider のプロフィールページを開く）。
- **一覧部**: 既存 `PostCard` を再利用し、スレッド入口（`onOpenThread`）と操作ハンドラ（reply / quote / reaction / like / repost）を TimelineCore と同等に配線する（nostr 投稿は閲覧のみ）。**無限スクロール**で `cursor` 追加読み込み（Timeline と同じ処理。`nextCursor` が null で終了）。自動更新・新着ピルは無し。
- **置換**: 一覧内の別ユーザー入口（リポスト行・quote card の著者行）で、**同一オーバーレイ内でプロフィールを置き換えて引き直す**（[§2](#2-ナビゲーション)）。本人への入口は反応しない。
- **他のオーバーレイとの関係**: プロフィールから Thread / Compose を開いた場合は**プロフィールを閉じて開く**（オーバーレイはスタックしない。閉じた先はタイムラインに戻る）。Thread からプロフィールを開いた場合は Thread の上に重ねて開き、閉じると Thread に戻る（ThreadView の入口はそのまま生きる）。
- 状態:
  - 概要読込中: スピナ。
  - **概要取得失敗（取得不能）**: [§9](#9-取得不能アカウント) のプレースホルダ。
  - 一覧のみ失敗: エラー行＋再試行ボタン（概要は表示したまま）。
- 閉じる: フォーカストラップ・スクロールロック・フォーカス返却（Lightbox / ThreadView と同じ規約）。

## 9. 取得不能アカウント

アカウント削除・移行（DID 差し替え）・ブロック・リレー欠落等で概要を取得できない場合は、**オーバーレイを開いたまま**「このユーザーは表示できません」の案内と閉じる手段（× / 背景タップ / Esc）だけを表示する。`ThreadNode.unavailable` / `quoteUnavailable` と同じイディオム。

## 10. テスト方針（[ADR-0001](./adr/0001-test-scope-no-e2e.md) / [ADR-0002](./adr/0002-test-coverage-boundary.md) の範囲）

- **BFF 契約**（`bsky.test.ts` / `misskey.test.ts` 拡張）:
  - profile 映射（author・description / descriptionRich・banner・stats・viewer.following / followUri・url）。
  - profile/posts 映射（bsky の `reasonRepost → repostedBy` 映射・cursor エコー、misskey のリノート映射・untilId エコー）。
  - follow 操作（POST / DELETE。bsky の recordUri 削除・misskey の userId 指定。nostr 400）。
- **Nostr 解決**（`shared/nostr.test.ts` 拡張）:
  - `parseProfile` の about / banner 解析。
  - kind:1 / kind:6 の pubkey 照会による一覧組み立て（`TimelineResponse` 形状一致・`repostedBy` 映射）。
- **コンポーネント**（`ProfileView.test.tsx` 新規、`PostCard.test.tsx` / `NotificationCard.test.tsx` 拡張）:
  - 入口クリックで開く（全 Provider）／Media・リンク・ボタンは貫通しない（Thread を開かない）。
  - ヘッダー部の描画（カウント・follow ボタンの表示条件: nostr 非表示・自分非表示）。
  - 無限スクロールの追加読み込み。
  - 別ユーザー入口での置換（本人入口は反応しない）。
  - 取得不能プレースホルダ。
  - follow トグルの楽観更新。

## 11. 用語（`CONTEXT.md` 反映済み）

- **Profile（プロフィール）**: Author の詳細情報（自己紹介・バナー・統計）とその表示単位。投稿に埋め込まれる軽量な Author に対し、Profile は「その人の中身を見た」姿。Provider により持てる情報が異なる（Nostr は統計を持たない）。
- **follow（フォロー）**: Author を自分のタイムラインに迎え入れる Provider 側の基本関係。Profile 表示から行う（bsky / misskey のみ）。
- **Author**: Profile との関係を追記して sharpen 済み（投稿に埋め込まれる軽量な姿であり、詳細情報は Profile で見る）。
