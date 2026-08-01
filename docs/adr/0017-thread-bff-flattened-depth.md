# スレッドは BFF が平坦化（DFS 順＋depth）して返し、Post に親子フィールドを持たせない

スレッド表示（[thread-view-spec.md](../thread-view-spec.md)）では祖先・子孫の木構造が必要だが、Provider で取得形態が異なる（Bluesky は `getPostThread` が木を返す、Misskey は `notes/conversation`＋`notes/children` の平坦リスト）。この差異を **BFF が吸収し、描画可能な平坦構造（`ThreadResponse`: ancestors は root 先頭、replies は DFS 順＋`depth`）で返す**。統一モデル `Post` には root/parent 等の親子フィールドを追加しない。Provider 差異の吸収は BFF の責務という既存方針（[ADR-0004](./0004-view-as-n-sources-client-merge.md) / [ADR-0005](./0005-unified-inline-richtext.md)）の延長で、クライアントを「描画するだけ」に保つため。

## Considered Options

- **Post に parent/root を足し、クライアントで木を構築する** — 柔軟だが、プロバイダ固有の構造が統一モデルに漏れ、クライアントに木構築の複雑さを強いる。`CONTEXT.md` の reply 項が実装詳細（root/parent）を語っていた漏れも温存される。
- **ネストした木 JSON を返す** — 素直だが、クライアントの再帰描画とページング（子孫の継ぎ足し）が扱いにくい。

## Consequences

- ワイヤ契約 `ThreadResponse` / `ThreadNode`（`shared/types.ts`）が新設される。`ThreadNode.unavailable` は `quote`/`quoteUnavailable` と同じイディオム。
- `CONTEXT.md` の reply 項を実装詳細の無い定義へ sharpen した（位置解釈は BFF に閉じ込める）。[ADR-0015](./0015-quote-card-inline-expand-external-link.md) が言及した「root/parent の正しい解釈」は、Post へのフィールド追加ではなく解決側（bsky/misskey は BFF、nostr はクライアント）のプロバイダ別解釈として解決する。
- **Nostr の扱い**: nostr はブラウザ直接 WebSocket（[ADR-0014](./0014-nostr-browser-direct-transport.md)）で BFF が平坦化できないため、クライアントが `queryRelays` で解決して**同じ `ThreadResponse` 形状を組み立てる**。本 ADR の本質は「平坦化の所在」ではなく「契約（ThreadResponse/ThreadNode）を統一し、Post に親子フィールドを持たせない」ことにある。UI はいずれの Provider でも同一の描画ロジックで済む。
