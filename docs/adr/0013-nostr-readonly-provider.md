# Nostr を読み取り専用 Provider として、BFF リクエスト単位 WebSocket で統合する

Nostr は ActivityPub ではないため ADR-0011（Threads）のような「Misskey 連合で吸収」ができず、閲覧にはリレー接続・署名検証・イベント変換の自前実装が必須。これを **`nostr` Provider の実装（ただし Destination を持たない読み取り専用）** として統合し、WebSocket はブラウザ直結でも Durable Object 常時購読でもなく **BFF（Worker）が `/api/timeline` の処理中にリレー群へリクエスト単位で開閉する**方式を採る。既存の `TimelineResponse` ポーリング契約と「UI は BFF とだけ話す」原則（ADR-0005）を壊さず、UI 変更をゼロにできるため。閲覧は署名不要なので nsec は一切扱わず、投稿対応は将来の独立 ADR に切り離す。詳細: [nostr-integration-spec.md](../nostr-integration-spec.md)。

## Considered Options

- **ブラウザがリレーに直接接続** — WS は CORS 制限がなく鍵も不要なので技術的には成立するが、Provider ごとに通信経路が分岐し、変換・検証責務がクライアントバンドルに移る。全 Provider で BFF 変換を貫いてきた設計との不一致が負債になると判断し却下。
- **Durable Object による常時購読** — リアルタイム性は上がるが、ポーリング＋新着ピルの既存 UX（CONTEXT.md の Timeline）が変わらず、インフラだけ一段重くなるため MVP では過剰として却下。
- **NIP-65 準拠のリレー解決** — 正確だが鶏と卵の追加ラウンドトリップが発生。固定リレーセットで実用上足りるとし、「取得できないユーザーが出たら」の再審トリガー付きで退けた（spec §4.4 / §8）。

## Consequences

- Worker にポーリングごとの WS 張替えコストが生じる（I/O 待ち主体のため CPU 制限には優しい）。常時購読への移行は将来の独立判断。
- `ProviderInfo.compose` が初の任意フィールドになる。UI 各所は「compose 無し＝投稿不可 Provider」のガードを持つ義務が生じる。
- 固定リレーセットの選定がカバレッジを決める。セット変更はコード定数の変更として行う。
