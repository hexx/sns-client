# Misskey ローカルカスタム絵文字の URL は BFF がインスタンスレジストリ（/api/emojis）から解決する

Misskey の Note が返す `reactionEmojis`・`emojis` には**リモートカスタム絵文字しか載らない**（サーバの `NoteEntityService` が `@` を含むキー＝リモートのみで populate する実装）。このため misskey.io 自身の絵文字（`:kawaii:` 等のローカルカスタム絵文字）は reaction チップ・本文インラインとも URL を得られず `:name:` テキストに縮退していた。BFF がインスタンスの絵文字レジストリ `POST /api/emojis`（認証不要・全件返却・サーバ側 `cacheSec: 3600`）を引き、`name → url` マップを**インメモリ TTL 30分・シングルフライト・lazy 取得**でキャッシュして、`Reaction.emojiUrl` と本文 `RichSegment`（emoji）の `url` を補完する。解決はローカルキー（`:name:` / `:name@.:`）専用とし、リモートキー（`:name@host:`）は `reactionEmojis` のみに任せる（同名別画像のローカル絵文字への誤解決防止）。レジストリ取得失敗時はテキスト縮退で続行する（非致命）。

## Considered Options

- `reactionEmojis` のみで解決（現状維持）— 却下：ローカルカスタム絵文字が一切画像化されない（今回のバグそのもの）
- クライアント側で絵文字マップを保持して描画時に解決 — 却下：「Provider 差異は BFF が吸収し、UI は統一モデルだけ扱う」原則（ADR-0005 と同思想）に反する
- Cache API / KV でレジストリを共有キャッシュ — 却下：Cloudflare Access 背後のシングルユーザー PWA では isolate 間共有の価値が無く、POST エンドポイントの詰め替えや新バインディングの複雑性が過剰
- **BFF が `/api/emojis` をインメモリ TTL キャッシュで引き、pack 時に解決（採用）**

## Consequences

- Worker に絵文字レジストリの fetch・キャッシュ（TTL・シングルフライト）と、reaction/本文共通の解決ロジックが追加される。
- cold start 後最初の Misskey タイムライン要求で `/api/emojis`（misskey.io は MB 級）を1回引く。シングルユーザー前提では許容。
- 絵文字の新規追加・URL 変更は最大で TTL 分（30分）遅れて反映される。
- 将来マルチユーザー化するなら Cache API / KV への載せ替えを検討する（その複雑性が正当化されるのはその時点）。
