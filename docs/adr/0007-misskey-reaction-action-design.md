# Misskey リアクション操作：楽観更新・単一 POST ルート・`ref` ターゲット

Misskey 投稿への reaction 付与/解除/置換を実装するにあたり、① UI は**楽観更新**（クリック即パッチ、失敗時ロールバック＋トースト）とし、② BFF API は REST の DELETE を使わず **単一 `POST /api/reactions`**（ボディ `{provider, postId, reaction?}`、`reaction` の有無で create/delete を表す）に統一し、③ 操作ターゲットは `post.id` ではなく **`post.ref`**（コンテンツ本体の noteId）を狙う。Misskey は1ユーザー1反応で、別絵文字の create はサーバ側で置換されるため delete→create の2段階は不要。`ref` ターゲットは、純粋 renote が `id`=renote 活動・`ref`=内包ノートであり、表示チップも内包由来であることと整合させるための意図的な選択。

## Considered Options

- サーバ応答待ちで UI 更新 — 却下：反応トグルは高頻度・低リスクで、往復待ちが体感を損なう。Misskey 公式 UI も楽観更新。
- REST 準拠（`POST`＋`DELETE /api/reactions`）— 却下：プロジェクトは GET/POST のみ・フラットパスの規約（DELETE の前例なし）。単一 POST は将来 Bluesky like 統合時にも `reaction` なし＝unlike で流用可能。
- Misskey 直写しの2 POST（`/reactions/create`・`/reactions/delete`）— 却下：ルートが増え、provider 統一の含意が弱まる。
- 操作後に `notes/show` で権威データを再取得して再同期 — 却下：反応ごとに往復倍増、シングルユーザーでは count ずれは見た目のみで次回 fetch で補正可能。
- ターゲットを `post.id` にする — 却下：純粋 renote で renote 活動 ID を叩いてしまい、表示チップ（内包ノート由来）と整合しない。

## Consequences

- クライアントはロールバック用に「操作前 reactions スナップショット」と1ノート in-flight 1件の連打ガードを持つ。
- BFF の ack（`{reaction}` エコー / delete は `{}`）で意図と受理を照合し、食い違いのみロールバックする。
- `reactionAcceptability` 等の反応制限は事前チェックせず、409 → ロールバック＋トーストで対処する（無駄クリックは許容）。
- 他者の同時反応による count ずれはリアルタイムでは補正されない（スコープ外）。
