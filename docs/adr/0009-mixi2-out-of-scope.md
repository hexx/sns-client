# mixi2 を Provider として統合しない（型上予約のみ）

mixi2 の公式 API は Bot/Plugin 用プラットフォーム（OAuth2 Client Credentials のみ・gRPC・TL 取得 API なし）であり、本アプリの Provider の定義（利用者 TL 閲覧＋本人名義投稿）を満たさない。そのため統合せず、`Provider` 型に `'mixi2'` を予約するに留め、「ユーザー委任 OAuth」と「ホーム TL 取得 API」の両立を再審トリガーとして確定した。詳細: [mixi2-integration-spec.md](../mixi2-integration-spec.md)。

## Considered Options

- 非公式 API（プライベート API 流用）で Provider 化 — 却下：ToS 違反・アカウント停止リスク、無告知変更への脆さ、認証機構の不透明さ。
- Bot ブリッジ（Bot 名義で投稿のみ）— 保留（設計しない）：技術的には成立するが、自分の compose 結果の `Post.author` が Bot になり作者同一性が壊れる。再審トリガー達成時に不要になる投資。
- 型予約もしない — 却下：`mastodon` 予約の前例があり、型での意图表明が安価。

## Consequences

- `KINDS.mixi2 = []`・`isProvider` は mixi2 を拒否・`/api/providers` に非配信、という「存在するが何もしない」状態が意図的に維持される。
- 将来「なぜ mixi2 がない／なぜ型だけある」の問いにこの ADR が答える。
