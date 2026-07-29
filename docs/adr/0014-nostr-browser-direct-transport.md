# Nostr の取得トランスポートを BFF 経由からブラウザ直接 WebSocket へ反転する

[ADR-0013](./0013-nostr-readonly-provider.md) が却下した「ブラウザがリレーに直接接続」を、**Nostr に限り採用**し、BFF（Worker）リクエスト単位 WebSocket を廃止する。運用確認で、BFF の送信元である Cloudflare Workers のデータセンター ASN が `wss://yabu.me` 等の **JP 限定リレーから構造的にブロックされる**（海外メガクラウド ASN 拒否）と判明し、ADR-0013 / nostr-integration-spec §4.4・§8 の**再審トリガー「固定セットで投稿を取得できないユーザーが出てきたとき」が発火**したため。日本語圏を主対象とする本アプリで、BFF 一貫性のために欲しいコンテンツ（JP 限定リレー）に届かないのは本末転倒と判断した。

本 ADR は ADR-0013 を**部分置換**する: 置き換わるのは**トランスポート選択（BFF リクエスト単位 WS）のみ**。**読み取り専用・鍵（nsec）非保持・Destination 非保持**の判断は ADR-0013 が引き続き典拠。bluesky / misskey は BFF 経路のまま据え置く（ハイブリッド）。詳細: [nostr-browser-direct-spec.md](../nostr-browser-direct-spec.md)。

## Considered Options

- **BFF 経路を維持し、固定リレーをグローバルリレーに絞って JP 限定リレーを諦める** — 却下：ゼロコストだが、日本語圏アグリゲーター（yabu.me）等のカバレッジを恒久的に失う。アプリの主対象と矛盾。
- **BFF 経路をフォールバックとして残すデュアルパス** — 却下：BFF は肝心の JP 限定リレーに到達できずフォールバックとして機能しない。二重管理の負債のみ。
- **ブラウザ直接 WebSocket を採用（採用）** — ADR-0013 も「技術的には成立」（WS は CORS 対象外・閲覧は鍵不要）と認めていた。nostr は読み取り専用で BFF を正当化する主因（秘密管理・CORS 吸収）が元々効かない唯一の Provider。`WsFactory` 抽象により移行も軽い。

## Consequences

- 取得・検証・変換ロジックを `shared/nostr.ts` に単一ソース化し、`worker/src/nostr.ts` と `/api/timeline` の nostr 提供を廃止。`/api/timeline?provider=nostr` は misskey へのフォールスルー防止のため明示的に `400` を返す。`KINDS.nostr` は `/api/views` 検証用に維持。
- 署名検証（schnorr＋id 再計算）をクライアントでも維持するため `@noble/curves` / `@noble/hashes` がクライアントバンドルに乗る（数十KB級）。ユーザー任意リレーに直接接続するため検証の重要性はむしろ上がる。
- 「UI は BFF とだけ話す」原則（ADR-0005 由来）に **Nostr 限定の例外**が生じる。ただし ADR-0005 の不変条件「UI は統一 `Post` のみを扱う」は保たれる（変換は `shared/` で同一出力）。
- プロフィール（kind 0）キャッシュは「全ユーザー共有（BFF）」から「端末・セッション単位」に退化（インメモリ TTL は継承）。
- `/api/timeline` を通らないため、`sw.ts` の network-first キャッシュによる nostr のオフライン最終成功表示は MVP では効かなくなる（bluesky/misskey は有効）。
- 固定リレーセットに JP 限定リレー（少なくとも `yabu.me`）を追加する（仕組みはコード定数のまま）。
- リレー到達性がエンドユーザーのネットワーク依存になる（BFF 時代は全ユーザー一律）。不通リレーの Source 単位エラー表示（ネットワーク制限ヒント付き）で対処。
