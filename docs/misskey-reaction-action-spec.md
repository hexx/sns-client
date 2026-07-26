# Misskey リアクション操作 仕様

タイムライン上の Misskey 投稿へ、絵文字リアクションを**付ける・外す・置き換える**操作を実装する。現状は reaction チップの表示のみ（`me` 強調あり）で、書き込みはできない。本仕様は操作モデル・絵文字ピッカー・BFF API・楽観更新の振る舞いを定める。**Misskey の reaction のみ**対象（Bluesky の like は対象外）。

## 前提事実（Misskey API）

- 反応は **1ユーザーにつき1投稿1つ**。`myReaction` は単一値。
- `notes/reactions/create`（`{noteId, reaction}`）：無反応→付与、**別絵文字で既に反応済み→サーバ側で置換**（1コール）。同一絵文字の二重 create は `ALREADY_REACTED`（error id `51c42bb4-...`）で失敗。
- `notes/reactions/delete`（`{noteId}`）：自分の反応を解除。
- `reaction` パラメータは Unicode 絵文字文字（`👍`）または自インスタンスのローカルカスタム絵文字（`:name:`）。
- 絵文字レジストリ `POST /api/emojis`（認証不要・全件）は BFF が既にインメモリ TTL 30分・シングルフライトでキャッシュ済み（ADR-0006）。

## 用語（`CONTEXT.md` 反映済み）

- **reaction**: 1ユーザー1反応の意味論（再選択で解除、別絵文字で置換）を追記済み。

## 操作モデル

- **チップクリック＝トグル**：既存 reaction チップをクリック。未反応→その絵文字で create、自分の反応（`me`）→ delete、別絵文字で反応済み→ create（置換）。
- **「＋」ボタン→絵文字ピッカー**：まだ付いていない絵文字（カスタム含む）を選んで create。Misskey 投稿にのみ描画（`provider === 'misskey'` ゲート）。Bluesky 投稿には反応 UI を一切描画しない。

## 絵文字ピッカー

- **データソース**：新エンドポイントで ADR-0006 のキャッシュを再利用しクライアントへ配信。生レジストリ（misskey.io は MB 級・フィールド過多）を **`{name, url, aliases?}` に compact 化**して返す。新規 fetch は発生しない。
- **中身**：先頭に**小規模キュレーション Unicode パレット**（10〜20個、クライアント静的配列）、その下にレジストリ由来のローカルカスタム絵文字。
- **検索**：name / aliases の部分一致のみ。カテゴリ・ファジー・ランキングは MVP ではやらない。
- **描画**：数千件前提（仮想スクロール等の軽量化）。fetch は lazy（「＋」初回クリック時）＋ブラウザ側セッションキャッシュ。

## BFF API

- **`POST /api/reactions`**、ボディ `{provider, postId, reaction?}`。
  - `reaction` あり → `notes/reactions/create`（付与/置換）
  - `reaction` なし → `notes/reactions/delete`（解除）
  - `postId` は Misskey noteId、`reaction` は Misskey へ**パススルー**（正規化ほぼ不要）。
- **ターゲットは常に `post.ref`**（コンテンツ本体の noteId）。純粋 renote は `post.id`＝renote 活動 ID・`post.ref`＝内包ノート ID であり、表示チップも内包由来のため、`ref` を狙うことで表示と整合する。**`post.id` ではない**（落とし穴）。
- **応答**：create/replace は `{reaction}` をエコー、delete は `{}`。
- **エラー**：Misskey 起因（`ALREADY_REACTED`・ブロック中・反応不可設定等）は **409 ＋ `{error: <code>}`**。認証系は既存 `run()` ラッパー（503/502/401）に委ねる。
- `shared/constants.ts` の `API` 定数に1行追加（既存のフラットパス・GET/POST のみ規約に準拠）。

## 楽観更新と状態整合

- クリック直後にローカル状態を即パッチ（`count±1`・`me` 反転/移動）。置換は「旧 `me` 絵文字 count−1・新絵文字 count＋1・`me` 移動」。
- API はバックグラウンドで呼び、**失敗時は操作前スナップショットへロールバック＋エラートースト**。
- **連打ガード**：1ノート in-flight 1件。
- **成功後はローカルパッチ確定**（サーバ再取得しない）。BFF の ack エコーで意図と受理を照合し、食い違いのみロールバックの引き金。他者の同時反応による count ずれは見た目のみ・次回 fetch で補正と許容する。

## 境界・例外の裁定

- 引用（`post.quote`）の内包投稿には反応 UI を付けない（外側ポストのみ）。
- `reactionAcceptability`（反応制限設定）は事前チェックしない。pack に含めず、制限違反は 409 → ロールバック＋トーストで対処。
- 自分の投稿への反応は許可（Misskey が許可）。

## スコープ外（今回やらない）

- 他者の反応のリアルタイム反映（ストリーミング）— 次回 fetch で補正。
- 「最近使った絵文字」の永続化（将来候補）。
- 反応した人一覧（count のみ）。
- Bluesky の like、マルチアカウント/マルチインスタンス。

## テスト範囲（ADR-0001/0002 準拠、E2E なし）

- **BFF ルーティング契約**（`worker/index.ts`）：`POST /api/reactions` のステータス（200/400/409/502…）、`reaction` 有無の分岐、エラーマッピング。
- **主要 UI**（`PostCard`＋ピッカー）：トグル三分岐（create/delete/replace）、楽観パッチとロールバック、`provider` ゲート、`ref` ターゲット。
- **`app/api.ts`** のエラー処理。
- 測らない：Misskey エージェントの薄い wrapper 本体、sw/エントリ。
