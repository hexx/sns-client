# 通知は統一 Notification モデルとし、bsky の対象投稿は BFF が補完取得する

通知は Post とは別の統一モデル（`Notification`）として BFF が変換する（[notifications-spec.md](../notifications-spec.md) §3、ADR-0005 の思想の延長）。UI の3分類（投稿を伴う / actor のみ / テキストのみ）は type を正規化せず、フィールドの有無で判定する。

Bluesky の like / repost 通知は対象投稿がペイロードに含まれず `reasonSubject` の URI のみ渡されるため、BFF が `getPosts` バッチ（25 URI/回）で補完取得して `post` に載せる。取得不能（削除・ブロック等）は `postUnavailable: true` とし、遷移先は持たない。Misskey は reaction / renote 通知に `note` が同梱されるため追加取得しない（mention / reply / quote は両 Provider とも全文入り）。

**Considered Options**
- 対象投稿を載せず `subjectRef`（URI）のみ持つ: 一覧の情報量が半減する（「◯◯ さんがいいねしました」のみ）ため不採用。クリック時の Thread 取得では「どの投稿に」が一覧で分からない。
- 通知ごとに個別 fetch: N+1 になるため不採用。`getPosts` バッチで1ページ分（30件）でも高々2リクエストに収まる。

**Consequences**
- 一覧の取得コストが bsky 側で +1〜2 リクエストになる（許容範囲。部分障害時は該当通知のみ `postUnavailable` に縮退できる）。
- `Notification.type` は Provider 生タイプの写像であり、正規化しない。新タイプの追加は union と写像表・描画の追記で済む。
