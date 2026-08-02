# 通知表示（notifications）機能 仕様

他ユーザーの行動（返信・メンション・引用・いいね/リアクション・リポスト/リノート・フォロー等）を、既存の **View 機構**の1つとして一覧表示する。Bluesky / Misskey の通知 API の差異は BFF が吸収し、統一 **Notification** モデルに変換する（[ADR-0019](./adr/0019-notification-unified-model.md)）。用語は [CONTEXT.md](../CONTEXT.md) の **Notification** / **Source** / **View** / **Thread** を参照。

## 1. スコープ

### 対象（MVP）
- **Bluesky・Misskey** 両 Provider の通知一覧（1つの通知 View に時系列合成）。
- 全タイプの表示（投稿を伴う / actor のみ / テキストのみ の3分類。周辺タイプも表示できるものはする）。
- 既読管理（View に表示された瞬間の全既読＋未読数バッジ）。
- 投稿を伴う通知からの **Thread** 遷移（既存オーバーレイの再利用）。

### 非対象
- **Nostr**（読み取り専用 Provider でサーバー側通知が存在しない。ADR-0013/0014）。
- 通知の**個別既読**（両 Provider の API に存在しない。[§5](#5-既読管理とバッジ)）。
- タイムラインの「新着ピル＋取り込み」機構（unread-divider-spec）の通知への適用。
- プッシュ通知（sns-client-spec Phase 2 候補。本仕様の上に載せられる将来拡張）。
- Author 別ストリーム（通知からのプロフィール遷移は将来拡張。[§10](#10-将来拡張)）。

## 2. ナビゲーション

- 通知は既存の **View 機構**（デッキカラム／スマホ pager）で表示する。ルーター・モーダルは導入しない。
- **プリセット View「通知」**を常設する（[ADR-0020](./adr/0020-notifications-as-view-source.md)）。
  - プリセット構成: 「ホーム」（既存）と「通知」の2 View。通知 View は `bluesky notifications` + `misskey notifications` の2 Source を時系列合成する（ホーム View と同型の合成。通知同士の合成は許可）。
  - KV にカスタム View が保存されている環境（既存ユーザー）では、**通知 Source を含む View が無ければ配信時に「通知」View を先頭に注入して返す**（KV には書き戻さない）。
  - 通知 View の**削除**は `PUT /api/views` で保存された views に含まれない状態として表現され、以降は注入しない。カタログ（`/api/sources` の notifications オプション）から**再追加**できる。
- **合成ルール**: 通知 Source は通知 Source とのみ共存できる。Post ストリーム（home / antenna / list / feed 等）とは混ぜない。`PUT /api/views` の検証（`validateViews`）に「notifications Source を含む View は通知 Source のみで構成される」ことを追加する。

## 3. ドメインモデル（`shared/types.ts` 追加）

```ts
/** 通知タイプ。Provider 生タイプの写像。UI の3分類は type でなくフィールドの有無で判定する */
export type NotificationType =
  // 投稿を伴う（両 Provider）
  | 'mention' | 'reply' | 'quote'
  // 投稿を伴う（Bluesky）
  | 'like' | 'repost' | 'like-via-repost' | 'repost-via-repost' | 'subscribed-post'
  // 投稿を伴う（Misskey）
  | 'reaction' | 'renote' | 'pollVote' | 'pollEnded' | 'note' | 'app'
  // actor のみ（両 Provider）
  | 'follow'
  // actor のみ（Bluesky）
  | 'starterpack-joined' | 'contact-match'
  // actor のみ（Misskey）
  | 'receiveFollowRequest' | 'followRequestAccepted'
  // テキストのみ（Bluesky）
  | 'verified' | 'unverified'
  // テキストのみ（Misskey）
  | 'achievementEarned' | 'roleAssigned' | 'chatRoomInvitationReceived' | 'exportCompleted' | 'login' | 'createToken' | 'test'
  | 'scheduledNotePosted' | 'scheduledNotePostFailed';

/** 統一通知モデル。Post とは別概念（docs/notifications-spec.md、ADR-0019） */
export type Notification = {
  id: string; // bsky: 通知レコードの at-uri / misskey: 通知 id
  provider: 'bluesky' | 'misskey';
  type: NotificationType;
  createdAt: string; // ISO 8601
  isRead: boolean; // サーバー側の既読状態（UI の未読強調には使わない。§5）
  actor?: Author; // 誰が（follow / like / reaction / mention / reply / quote 等）
  post?: Post; // 対象投稿（mention/reply/quote は相手の投稿。like/repost/reaction/renote は「あなたの投稿」）
  postUnavailable?: boolean; // 対象投稿が取得不能（削除・ブロック等）。post と排他。遷移先は無い
  text?: string; // テキストのみの通知の表示文
  reaction?: string; // Misskey のリアクション絵文字キー（reaction 通知のみ。文言に添える）
};
```

### 3.1 3分類（フィールドの有無で判定）

| 分類 | 判定 | 例 |
|---|---|---|
| 投稿を伴う | `post` または `postUnavailable` を持つ | mention / reply / quote / like / repost / reaction / renote / pollVote / pollEnded |
| actor のみ | `actor` を持つ（`post` なし） | follow / starterpack-joined / receiveFollowRequest / contact-match |
| テキストのみ | `text` を持つ | achievementEarned / verified / roleAssigned / exportCompleted / login |

### 3.2 タイプ写像表

| 分類 | Bluesky（reason） | Misskey（type） |
|---|---|---|
| 投稿を伴う | mention / reply / quote | mention / reply / quote |
| 投稿を伴う | like / like-via-repost | reaction |
| 投稿を伴う | repost / repost-via-repost | renote |
| 投稿を伴う | subscribed-post | note / pollVote / pollEnded / app |
| actor のみ | follow / starterpack-joined / contact-match | follow / receiveFollowRequest / followRequestAccepted |
| テキストのみ | verified / unverified | achievementEarned / roleAssigned / chatRoomInvitationReceived / exportCompleted / login / createToken / test / scheduledNotePosted / scheduledNotePostFailed |

## 4. データ取得（BFF）

### 4.1 `GET /api/notifications?provider=&cursor=`

```ts
type NotificationsResponse = {
  notifications: Notification[];
  unreadCount: number; // この View の未読数（プロバイダ別。合成表示時は合算）
  nextCursor: string | null; // 追加ページのカーソル（bsky: cursor / misskey: untilId）
};
```

- **Bluesky**: `app.bsky.notification.listNotifications({ limit: 30, cursor })` → 各通知を写像。
  - mention / reply / quote はペイロードに全文入り（`record`）→ `mapPost` で `post` に載せる。
  - like / repost / like-via-repost / repost-via-repost は対象投稿が含まれない（`reasonSubject` の URI のみ）→ **BFF が `getPosts` バッチ（25 URI/回）で補完取得**して `post` に載せる。取得不能（削除・ブロック等）は `postUnavailable: true`（[ADR-0019](./adr/0019-notification-unified-model.md)）。
- **Misskey**: `mkApi('i/notifications', { limit: 30, untilId: cursor, markAsRead: false })` → `note` は既存 `mapPost` で `post` に載せる。
  - **`markAsRead: false` を明示する**（Misskey はデフォルト `true` で、ポーリングだけで全既読になるのを防ぐため。既読化は §5 の専用ルートで行う）。
- **unreadCount**:
  - Bluesky: `app.bsky.notification.getUnreadCount()` → `count`。
  - Misskey: `mkApi('i')` の `unreadNotificationsCount`（旧バージョンは `unreadNotifications`。どちらか読める方を読む）。

### 4.2 `POST /api/notifications/read`（全既読）

- **Bluesky**: `app.bsky.notification.updateSeen({ seenAt: new Date().toISOString() })`。
- **Misskey**: `i/notifications` を `markAsRead: true` で空取得（limit 1）。サーバー側で `readAllNotification` が走る（`i/read-all-notifications` は develop で廃止済みのためこちらを使う）。

## 5. 既読管理とバッジ

- **既読化トリガー**: View が**表示中**に新着が取り込まれた瞬間、および View がアクティブになった瞬間に `POST /api/notifications/read`（全既読）。「見えているものは既読」が原則。
  - モバイル: アクティブタブ = 表示中。非アクティブタブは一覧に挿入せずポーリングで未読数のみ更新。
  - デスクトップ: デッキは全カラム常時表示のため、通知カラムがマウントされている間は常に表示中（新着は届いた瞬間に既読。バッジは通常 0 になる。カラムヘッダーバッジは非表示中のみ意味を持つが、デッキの性質上ほぼ機能しないため、バッジの主な受け皿はモバイルのタブバッジ）。
- **バッジ**: View が非表示の間に増えた `unreadCount` を表示。スマホは既存のタブバッジ（`pager-badge`、99+ 上限）を流用。デスクトップはカラムヘッダーバッジ（表示中のため通常 0）。
- カード単位の未読強調は**行わない**（表示中のものは常に既読のため）。`isRead` はモデルに載せるが、UI の用途は将来拡張に備えたもの。

## 6. 通知カードの描画

- タイプ別アイコン（mention / reply / quote / like / reaction / repost / follow 等の種別を一見で判別）。
- **投稿を伴う**: `actor`（アバター＋表示名）＋文言＋対象 `post` のプレビュー（既存 PostCard の縮小表示。CW は既存の折りたたみ流儀を踏襲）。
- **actor のみ**: `actor` ＋文言のみ。
- **テキストのみ**: `text` をそのまま表示（例: 「実績を獲得しました」「新しいデバイスからログインしました」）。
- 文言は統一表記（Provider 差を吸収済みの例）:
  - `「{actor} さんがあなたの投稿にいいねしました」`（like）
  - `「{actor} さんがリアクションしました {絵文字}」`（reaction）
  - `「{actor} さんがリポストしました」`（repost / renote）
  - `「{actor} さんがフォローしました」`（follow）
  - `「{actor} さんがあなたに返信しました」`（reply）
  - `「{actor} さんがあなたをメンションしました」`（mention）
  - `「{actor} さんがあなたの投稿を引用しました」`（quote）

## 7. 遷移と操作

- **投稿を伴う**通知のカードクリック → 対象 `post` の **Thread オーバーレイ**を開く（`post.ref` をエコーして既存 `GET /api/thread` へ。スレッド内の reply / like / repost / reaction は既存機構がそのまま動く）。
- `postUnavailable`（対象投稿が取得不能）→ **遷移なし**。「投稿は取得できません」の案内行のみ（quote card の `quoteUnavailable` と同一イディオム）。
- **actor のみ・テキストのみ** → 遷移なし（表示のみ）。Author 別ストリームは将来拡張（§10）。
- 通知一覧から直接の reply / reaction 操作は持たない（Thread 経由で行う）。

## 8. ページング

- 既存タイムラインと同じ**無限スクロール**。スクロールで `nextCursor` を渡して古い通知を継ぎ足す。
  - Bluesky: `listNotifications` の `cursor`。
  - Misskey: `i/notifications` の `untilId`。

## 9. 更新頻度（ポーリング）

- 既存の TimelineCore ポーリング機構に統合（misskey 15 秒 / bluesky 30 秒。非表示 View も常時監視する既存方針のまま）。
- 一覧取得と同時に `unreadCount` も更新される（別エンドポイントは作らない）。
- 注意: Misskey の `i/notifications` はレート制限 30 回/30 秒。ポーリング 15 秒＋初期取得＋追加ページの範囲では問題ないが、一覧・既読化・未読数の取得は同じ制限内に収める。

## 10. 将来拡張

- **プッシュ通知**（sns-client-spec Phase 2）。本仕様の未読数ポーリングの上に載せられる。
- **Author 別ストリーム**（通知カードから「その人の投稿一覧」への遷移。Source 機構の拡張が必要なため本仕様では対象外）。
- 通知タイプのフィルタ（表示するタイプの選択。Misskey の `includeTypes` / `excludeTypes` は API として利用可能）。

## 関連ドキュメント

- [ADR-0019](./adr/0019-notification-unified-model.md) — 通知の統一モデルと bsky 対象投稿の補完取得
- [ADR-0020](./adr/0020-notifications-as-view-source.md) — 通知を View/Source 機構に統合
- [thread-view-spec.md](./thread-view-spec.md) — Thread 遷移先（§7）
- [unread-divider-spec.md](./unread-divider-spec.md) — タイムラインの新着機構（非対象の確認）
