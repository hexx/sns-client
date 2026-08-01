# スレッド表示（thread view）機能 仕様

タイムライン上の投稿をクリックすると、その投稿を**フォーカス投稿**として、祖先（root までの親連鎖）と子孫（リプライ群）をオーバーレイで表示する。Provider ごとのスレッド取得の差異は、Bluesky / Misskey は BFF が、Nostr はブラウザ直接解決が吸収し、いずれも同じ平坦構造（DFS 順＋depth）の `ThreadResponse` に合流する（[ADR-0017](./adr/0017-thread-bff-flattened-depth.md)）。用語は [CONTEXT.md](../CONTEXT.md) の **Thread** / **reply** / **quote card** を参照。

## 1. スコープ

### 対象（MVP）
- **Bluesky・Misskey・Nostr** の投稿に対するスレッド表示（祖先＋フォーカス＋子孫）。
- スレッド内からの既存操作（reply / like / repost / reaction）の再利用（Nostr は読み取り専用のため閲覧のみ。[ADR-0014](./adr/0014-nostr-browser-direct-transport.md)）。
- 取得不能ノード（削除・ブロック等）のプレースホルダ表示。
- quote card クリックによる引用先スレッドへの遷移（[§7](#7-quote-card-からの遷移adr-0015-再審の決着)）。

### 非対象
- スレッド新着のポーリング・自動挿入。スレッドは開いた瞬間のスナップショット。
- 子孫のソート（いいね順等）。時系列（DFS）順のみ。
- アプリ内ディープリンク・ブラウザ戻るボタンでの閉じ（ルーター非導入。[§2](#2-ナビゲーション)）。

## 2. ナビゲーション

- **オーバーレイ**で開く（Lightbox / Compose モーダルと同一パターン。ルーターは導入しない）。
  - デスクトップ: 背景を暗くした中央パネル（最大幅・上下スクロール）。
  - モバイル: 全画面オーバーレイ。
- 閉じる操作: Esc・背景クリック・閉じるボタン（Lightbox と同一流儀）。ブラウザの戻るボタンでは閉じない（ルーター非導入のトレードオフ）。
- 共有 URL の必要性は既存のパーマリンク `Post.url` で足りるため、アプリ内ディープリンクは持たない。

## 3. ドメインモデル（`shared/types.ts` 追加）

```ts
/** スレッド表示の応答。bsky/misskey は BFF（GET /api/thread）が、nostr はブラウザ直接解決がこの形状を組み立てる */
export type ThreadResponse = {
  focus: Post;            // フォーカス投稿
  ancestors: Post[];      // root → focus 直前まで。root 先頭（時系列昇順）
  replies: ThreadNode[];  // focus の子孫。深さ優先（DFS）で平坦化した順
  nextCursor: string | null; // 子孫の追加ページカーソル（Misskey のみ。bsky/nostr は常に null）
};

/** スレッド子孫の1ノード。取得不能ノードは post を持たず unavailable で表す（quote/quoteUnavailable と同一イディオム） */
export type ThreadNode = {
  post?: Post;
  unavailable?: boolean; // 削除・ブロック・リレー欠落等で取得不能
  depth: number;         // focus 直下 = 1。描画インデントに使う
};
```

設計原則:
- **Post 自体には親子フィールド（root/parent）を追加しない。** スレッド構造は `ThreadResponse` / `ThreadNode` が担う。位置解釈は bsky/misskey では BFF、nostr ではクライアントの解決ロジックに閉じ込める（[ADR-0017](./adr/0017-thread-bff-flattened-depth.md)）。
- `unavailable` は `post` と排他（quote-display-spec の `quote` / `quoteUnavailable` と同じ保証）。

## 4. BFF（`GET /api/thread`、Bluesky / Misskey）

### 4.1 ルート（`worker/src/index.ts` 追加、`shared/constants.ts` の `API` に `thread: '/api/thread'`）

```
GET /api/thread?provider=<provider>&ref=<JSON encoded opaque>&cursor=<opaque?>
```

- `ref` は `Post.ref` の opaque エコー（repost と同じ流儀。クライアントが `encodeURIComponent(JSON.stringify(post.ref))` で渡す）。
- `provider` 検証は `/api/timeline` と同じ（`isProvider`）。**nostr は 400**（ブラウザ直接取得のため BFF 非対応。timeline と同じガード）。
- 認証失敗・プロバイダエラーのハンドリングは既存の `onError`（503/401/502）をそのまま使う。

### 4.2 Bluesky（`worker/src/bsky.ts` 追加）

`agent.getPostThread({ uri, parentHeight: 25, depth: 10 })` を呼び、`ThreadViewPost` を解釈する。

| ThreadViewPost の形 | 映射 |
|---|---|
| `post`（通常ノード） | 既存の bsky 投稿映射で `Post` 化 |
| `notFound` / `blocked` | `ThreadNode { unavailable: true, depth }` |

- **祖先**: フォーカスノードから `.parent` を辿って収集し、**root 先頭になるよう反転**して `ancestors` とする（`parentHeight: 25` で上限制約）。
- **子孫**: フォーカスノードの `.replies` を**深さ優先（DFS）**で走査し、`depth`（focus 直下=1）を付与して `replies` に平坦化する。
- Bluesky はリプライのカーソルページングを持たないため `nextCursor` は常に `null`。`depth: 10` を超える深い階層は API 側で打ち切られる（MVP 許容）。

### 4.3 Misskey（`worker/src/misskey.ts` 追加）

`mkApi` 経由で3エンドポイントを組み合わせる。

| 目的 | エンドポイント | 備考 |
|---|---|
| フォーカス | `notes/show { noteId }` | 既存 `mapNote` で `Post` 化 |
| 祖先 | `notes/conversation { noteId, limit: 25 }` | 親連鎖を返す。BFF が **root 先頭に反転** |
| 子孫 | `notes/children { noteId, limit: 30, until? }` | `replyId` 付きの平坦リスト。`until` でページング |

- **子孫の木再構築**: `notes/children` は平坦なリプライ列（各ノートが `replyId` を持つ）。BFF が `replyId` で親子関係を再構築し、**DFS 順＋depth** に平坦化する。親が取得集合に無いノードは、取得不能な中間ノードを `unavailable` で挿入して木構造の連続性を保つ。
- **ページング**: `notes/children` の `until` を `nextCursor` としてエコー。クライアントの継ぎ足し要求で同じルートを `cursor` 付き再呼び出し。
- 絵文字解決・CW・channel 等の映射は既存 `mapNote` をそのまま再利用する。

### 4.4 Service Worker キャッシュ

`/api/thread` は **NetworkOnly**（会話データは鮮度が命。既存の「その他 `/api`（投稿/メディア）は NetworkOnly」方針に追従。`app/src/sw.ts`）。

## 5. Nostr のブラウザ直接解決

Nostr は読み取り専用・ブラウザ直接 WebSocket（[ADR-0014](./adr/0014-nostr-browser-direct-transport.md)）のため BFF を経由せず、クライアントが既存の `queryRelays`（`shared/nostr.ts`）でスレッドを解決し、**他 Provider と同じ `ThreadResponse` 形状を組み立てる**。UI は Provider 差を意識しない。

- **子孫**: `{ kinds: [1], '#e': [...] }` を固定リレーセット（`NOSTR_RELAYS`）へ照会する。`#e` は直接参照しか返さないため、得られた子孫の id を frontier に BFS で拡張し、**合計 30 件**を1バッチの上限とする。追加ページングは MVP では行わない（`nextCursor` は常に `null`）。
- **祖先**: フォーカス自身の `e` タグを **NIP-10** で解釈して親を定め（marker `reply` のタグ＝親、marker `root`＝ルート。無 marker の旧式イベントは位置で解釈）、親を `{ kinds: [1], ids: [parentId] }` で順に遡る。**25 段**で打ち切り（bsky `parentHeight` / misskey `limit` と同値）。収集後 root 先頭に反転して `ancestors` とする。
- **木構築**: 子孫の `e` タグ（reply/root marker）で親子関係を再構築し、DFS 順＋depth に平坦化する。親が取得集合に無い場合は `unavailable` ノードを挿入して連続性を保つ。
- **取得不能**: リレーから得られなかったノードは `unavailable` プレースホルダ（[§8](#8-取得不能ノード)）。Nostr は「削除」と「リレーに無い」を区別できないが、表示は同一とする。
- **投稿者プロフィール**: 既存の kind:0 解決を再利用（表示名・アバター）。
- **操作**: Nostr は Destination を持たない（読み取り専用）ため、スレッド内の nostr 投稿に reply/like/repost/reaction は表示しない（閲覧のみ）。

## 6. UI

### 6.1 入口（`PostCard.tsx`）

- カード本文域（`<article>` の非インタラクティブ部分）クリックでスレッドを開く。`cursor: pointer`。**全 Provider（nostr 含む）**で有効。
- **クリックを貫通させない要素**（既存の `stopPropagation` 対象を維持）: リンク、Media サムネ（→ Lightbox）、アクションボタン群（reply/like/repost/react。nostr 投稿には元々無い）。
- 返信数 stats のクリックもスレッドを開く（affordance）。
- quote card のクリック挙動は [§7](#7-quote-card-からの遷移adr-0015-再審の決着) を参照（本文クリックとは別経路で、引用先のスレッドを開く）。

### 6.2 オーバーレイ（新コンポーネント `ThreadView.tsx`）

- `modal-backdrop` / `modal` パターン（Compose と同一）。ヘッダ（閉じるボタン＋「スレッド」＋Provider バッジ）＋スクロール本文。
- 本文の描画順: **ancestors → focus → replies**。各ノードは既存 `PostCard` を再利用し、アクションハンドラ（reply/like/repost/react）を TimelineCore と同等に配線する（nostr 投稿は閲覧のみ）。
  - **focus**: 強調表示（`.card-focus`。視覚的に区別）。
  - **ancestors / replies**: `depth` に応じた左インデント。**インデントは depth 5 で頭打ち**（それ以上は同一最大インデントで継続）。
  - **unavailable ノード**: 「この投稿は取得できません」プレースホルダ行（木構造の連続性を保つ）。
- **スレッド内の投稿クリック**: クリックした投稿を**新しいフォーカスとしてスレッドを引き直す**（同一オーバーレイ内で中身を置換。スタックしない）。「閉じる」でタイムラインへ戻る。貫通制御（Media/リンク/ボタン）はスレッド内のカードにもそのまま適用。
- 状態:
  - 読込中: スピナ。
  - 失敗: エラー行＋再試行ボタン。
  - フォーカス投稿自体が取得不能: 取得不能案内を表示（スレッドは成立しない）。

### 6.3 スレッド内操作

- **reply**: 既存 Compose を `replyTo = post.ref` で開く（既存機能）。投稿成功後は**スレッドを再取得**して最新化する（MVP。楽観挿入は将来）。
- **like / repost / reaction**: 既存の楽観更新ロジックをスレッド内のローカル状態に適用（TimelineCore と同じ engagement 流儀）。

## 7. quote card からの遷移（ADR-0015 再審の決着）

[ADR-0015](./adr/0015-quote-card-inline-expand-external-link.md) が残した「スレッドビューができたら quote card のクリック挙動を再審する」宿題を、**変更あり**で決着する。

- **quote card 本体のクリック＝引用先のスレッドを開く**（`cursor: pointer`）。開いた先は引用先自身の Thread で、通常のスレッドと同様に操作可能（card 上の表示が閲覧専用であることとは別物）。
- **「もっと見る」展開トグルと ↗ 外部リンクは `stopPropagation` で貫通しない**（インライン展開・外部リンクは従来どおり利用可能）。
- **`quoteUnavailable`**（既存の「元の投稿は表示できません」行）は遷移先が無いので入口を付けない。
- 対象は **bsky / misskey のみ**。nostr 投稿には quote 自体が無い（`shared/nostr.ts` に q タグ映射なし）。
- quote card の「表示専用・1階層・カード上に操作を載せない」という ADR-0015 の原決定は維持する。

## 8. 取得不能ノード

削除・ブロック・非公開・リレー欠落等で取得できないノードは、`ThreadNode.unavailable` プレースホルダ行（「この投稿は取得できません」）として木の中に残す。木構造の連続性を保ち、会話の途切れを利用者が理解できるようにする。quote card の取得不能案内（`quote` / `quoteUnavailable`）と同じイディオム。

## 9. テスト方針（[ADR-0001](./adr/0001-test-scope-no-e2e.md) / [ADR-0002](./adr/0002-test-coverage-boundary.md) の範囲）

- **BFF 契約**（`bsky.test.ts` / `misskey.test.ts`）:
  - 祖先の root 先頭反転。
  - 子孫の DFS 平坦化＋depth 付与。
  - unavailable ノード（bsky notFound/blocked、misskey 欠落親）の映射。
  - Misskey の nextCursor エコー。
- **Nostr 解決**（`shared/nostr.test.ts` 拡張）:
  - `#e` 照会による子孫収集と NIP-10 e タグ解釈（reply/root marker・無 marker 旧式）による祖先遡上。
  - 祖先25段打ち切り・DFS 平坦化・欠落ノードの unavailable 化。
  - `ThreadResponse` 形状が BFF 契約と一致すること。
- **コンポーネント**（`ThreadView.test.tsx` 新規、`PostCard.test.tsx` 拡張）:
  - ancestors/focus/replies の描画順と focus 強調。
  - depth インデント（5 頭打ち）。
  - 入口クリックで開く（nostr 含む）／Media・リンクは貫通しない。
  - スレッド内の投稿クリックでフォーカス置換（引き直し）。
  - quote card クリックで引用先スレッドへ遷移／「もっと見る」・外部リンクは貫通しない／quoteUnavailable は入口なし。
  - reply 成功後の再取得。

## 10. 用語（`CONTEXT.md` 反映済み）

- **Thread（スレッド）**: フォーカス投稿＋祖先＋子孫の会話の広がり。オーバーレイ表示の閲覧単位。
- **reply**: 位置解釈（root/parent）は BFF（nostr はクライアント解決）に閉じ込め、Post は親子フィールドを持たない。
- **quote card**: カード本体クリックで引用先の Thread へ遷移する（「もっと見る」トグル・外部リンクは別操作として維持）。
