# Threads は Provider 化せず Misskey 連合で吸収する

Threads ユーザーの投稿閲覧という確定した欲求に対し、`threads` Provider の新規実装ではなく Misskey の ActivityPub 連合経由の閲覧を採用した。Threads 投稿は Misskey ホーム Source にリモートノート（投稿者 `@user@threads.net`）として到着し、既存コード変更ゼロで統合タイムラインに混ざる。連合品質は外部インスタンス依存のため、位置づけは保証のない「文書化された振る舞い」。詳細: [threads-integration-spec.md](../threads-integration-spec.md)。

## Considered Options

- `threads` Provider を Threads API（graph.threads.net）で新規実装 — 却下：確定した欲求は閲覧のみで、連合で充足する。読み取り側 API は自分の投稿・メンション・レビュー必須のキーワード検索に限られ、他人のタイムライン購読 API は存在しない。Meta 開発者アプリ登録・Tech Provider 認証・権限ごとのアプリレビュー（2〜4週）・60日トークン更新の固定費が見合わない。
- 非公式 API で非連合ユーザーの購読を実現 — 却下：ToS 違反リスクと無告知変更への脆さ。[ADR-0009](./0009-mixi2-out-of-scope.md)（mixi2）と同型。
- `Provider` 型に `'threads'` を予約する — 却下：mastodon・mixi2 の予約は「将来対応予定／型での意図表明」だが、Threads は「連合で吸収するため Provider 不成立」と確定しており、予約は意図を誤って伝える。

## Consequences

- `shared/types.ts` の `Provider` 型・Worker・UI とも変更なし。「Threads 対応」はコードではなく文書（本 ADR と仕様書）にのみ存在する。
- 閲覧の成否は misskey.io ↔ threads.net の連合状態と相手アカウントの opt-in に依存し、アプリはそれを保証しない。検証手順は仕様書 §5。
- 将来「自分の Threads 名義で書きたい」という欲求が確定した場合は本 ADR を supersede する再設計が必要（書き込みは連合では原理不可）。再審トリガーは仕様書 §6。
