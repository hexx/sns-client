# Nostr ブラウザ直接接続（BFF 経由の廃止）仕様

> 複数 SNS を1画面で扱う PWA クライアント（[sns-client-spec.md](./sns-client-spec.md)）の
> **Nostr 取得トランスポートを「BFF（Worker）リクエスト単位 WebSocket」から「ブラウザ直接 WebSocket」へ反転**する確定仕様。
> 読み取り専用・鍵（nsec）非保持・`Post`/`Source`/`View` のドメインモデルは [nostr-integration-spec.md](./nostr-integration-spec.md) から継承・不変。変わるは**取得経路と固定リレーセットの構成**のみ。
> 作成: grill-with-docs セッション（全9問合意）に基づく。
> 関連 ADR: [ADR-0014](./adr/0014-nostr-browser-direct-transport.md)（[ADR-0013](./adr/0013-nostr-readonly-provider.md) のトランスポート判断を部分置換）/ [ADR-0004](./adr/0004-view-as-n-sources-client-merge.md) / [ADR-0005](./adr/0005-unified-inline-richtext.md)。用語は [CONTEXT.md](../CONTEXT.md) 参照。

---

## 1. 背景・問い

[nostr-integration-spec.md](./nostr-integration-spec.md)（ADR-0013）は、Nostr の取得を「UI は BFF とだけ話す」原則（ADR-0005）の一貫性から **BFF（Cloudflare Worker）がリレーへ outbound WebSocket** を開く方式とした。ブラウザ直接接続は「技術的には成立するが一貫性を破る負債」として却下された。

運用確認の結果、**BFF の送信元（Cloudflare Workers の anycast データセンター ASN）が、日本の一部リレーから構造的にブロックされる**ことが判明した。例: `wss://yabu.me`（複数国内リレーを集約する日本語圏アグリゲーター）はスパム対策として「日本国外 IP ＋ 国内ホスティング事業者 ＋ **海外メガクラウド** ＋ 海外 ISP の日本地域 IP」を ASN/IP レベルで拒否する。BFF 経由ではこれら JP 限定リレーに**全ユーザー一律で到達不能**になる。

これは ADR-0013 / nostr-integration-spec §4.4・§8 が定めた**再審トリガー「固定セットで投稿を取得できないユーザーが出てきたとき」**の発火とみなせる。本仕様はその再審の結果として、**Nostr に限りブラウザ直接接続へ反転**する。

## 2. 結論

1. **Nostr の Source（`pubkey` / `relay`）は、クライアント（ブラウザ）がリレーへ直接 WebSocket を開いて取得する。** bluesky / misskey は BFF 経路のまま据え置く（ハイブリッド）。
2. **取得・検証・変換ロジックは `shared/nostr.ts` に単一ソース化する。** Worker の nostr 実装（`worker/src/nostr.ts`）と `/api/timeline` の nostr 提供は**廃止**する。
3. **署名検証（schnorr＋id 再計算）はクライアントでも維持する**（`@noble/curves` / `@noble/hashes` をバンドル）。
4. **固定リレーセット（`NOSTR_RELAYS`）に JP 限定リレー（少なくとも `wss://yabu.me`）を追加する。** 仕組みはコード定数のまま（§6.1 継承）。
5. ドメインモデル（`Post` / `Source` / `View` / 統一リッチテキスト）は**不変**。ADR-0005 の不変条件「UI は統一 `Post` のみを扱う」は保たれる（変換の*場所*が Worker から shared/クライアントへ移るだけで、出力は同一）。

## 3. 事実根拠

### 3.1 Cloudflare Workers からの JP 限定リレー到達性

- 検証環境（日本の住宅 ISP / KDDI / 横浜）からは `wss://yabu.me` に接続成功。NIP-01 `REQ` に対し kind 1 イベント＋`EOSE` を正常受信。アプリの `getTimeline` 経由でもページング含め正常取得（30件/ページ、複数ページ遡行可）。
- 同環境からの IP 情報: `country=JP`, `org=AS2516 KDDI CORPORATION`（＝住宅 ISP）。
- 日本の Nostr リレー一覧（2026-03 更新）は `wss://yabu.me` を「日本国外 IP からのアクセスを拒否するリレー」に分類し、その制限を「**海外IPに加え、国内ホスティング事業者と海外メガクラウド、地域が日本と判定されているIPを保有している海外ISPの ASN 制限有**」と記載。Cloudflare Workers の送信元 ASN は「海外メガクラウド」に該当し拒否対象。
- `yabu.me` の NIP-11: `software=strfry`, `description="Aggregator relay for (mainly) Japanese users."`。

### 3.2 コード上の根拠

- クライアントは全 Source を `api.timeline(source, cursor)`（`/api/timeline`）一本で取得（`app/src/api.ts`、`app/src/components/TimelineCore.tsx`）。
- `worker/src/nostr.ts` は `WsFactory` を注入可能で、**トランスポート非依存**（テストは fake factory で差し替え）。純粋ロジック（`verifyEvent` / `toSegments` / `buildPost` / `queryRelays` / kind 0 解決）は Worker API に依存しない。例外は `defaultWsFactory`（`fetch(url, { headers: { Upgrade: 'websocket' } })`）のみで、これは Worker 専用 API。
- `app/src/components/Deck.tsx` の `parseNostrInput` は**ユーザー自由入力の `wss://` をそのまま `relay` Source** にする。ブラウザ直結化でクライアントは任意のリレーに接続しうるため、署名検証の重要性は BFF 固定リレー時代より**上がる**。
- `/api/timeline` ハンドラ（`worker/src/index.ts`）は `bluesky → nostr → その他(misskey)` の分岐。nostr 分岐を単純削除すると **misskey ハンドラへフォールスルーする**ため、廃止時は明示的な 400 が必要（§6.4）。

### 3.3 ADR-0005 との関係

ADR-0005 の本質は「UI は統一インラインリッチテキスト／`Post` のみを扱う」ことであり、変換*場所*が BFF であることは本質ではない。本仕様では変換を `shared/nostr.ts` で行い同一の `Post` を生成するため、UI から見た不変条件は保たれる。崩れるのは「UI は BFF とだけ話す」という transport 前提の Nostr 限定緩和のみ。

## 4. 却下・対象外とした案

### 4.1 BFF 経路をフォールバックとして残す（デュアルパス）— 却下

`shared/` 集約後も Worker 経路を残す案。しかし BFF フォールバックは**肝心の JP 限定リレーに到達できない**ためフォールバックとして機能せず、二重管理の負債だけ残る。単一ソース（クライアント直結）に統一する。

### 4.2 署名検証を諦める / 遅延検証 — 却下

バンドル軽量化のための検証省略、または表示優先の遅延検証。ユーザー任意リレーに直接接続する本方式では、検証を落とすと**悪意リレーが任意 pubkey 宛の偽イベントを注入**できる。`verifyEvent` は純粋で移動コストゼロ、`@noble/*` は数十KB級で許容。遅延検証は偽投稿が一瞬でも見えるため採用しない。

### 4.3 プロフィールキャッシュの永続化（localStorage / IndexedDB）— 対象外

TTL キャッシュをストレージに永続化する案。アバター URL の陳腐化・シリアライズ・容量管理を持ち込む MVP 過剰。インメモリ（セッション単位）で十分（§6.3）。

### 4.4 固定リレーセットを利用者設定可能にする — 対象外

セットを UI から編集可能にする案。§6.1 の「セット変更はコード定数」を維持する。利用者編集はカスタム View 編集の将来拡張に留める。

### 4.5 nostr 専用エラー UI の新設 — 却下

接続失敗表示のために nostr 専用 UI を起こす案。ADR-0004 の Source 単位エラー機構を再利用すれば足りる（§6.5）。

### 4.6 Service Worker による nostr オフラインキャッシュ — 対象外（MVP）

`/api/timeline` を通らないため `sw.ts` の network-first キャッシュ（オフライン最終成功表示）は nostr に効かなくなる。nostr 用の別途キャッシュは MVP では過剰として入れない（§7 Consequences）。

## 5. ドメインモデル対応

**変更なし。** `Provider='nostr'`、`Source` の2種別（`pubkey` / `relay`）、`Post`/`Author`/`RichSegment`/`Media`、`TimelineResponse`（`posts` + `nextCursor`）は nostr-integration-spec §5 と同一。`ProviderInfo.configured` は常に `true`、`compose` 無し（投稿不可）も継承。

## 6. 実装方式

### 6.1 固定リレーセット（構成の見直し）

仕組みは nostr-integration-spec §6.1 を継承（コード定数・`pubkey` Source と kind 0 取得先）。**構成に JP 限定リレーを追加**する。ブラウザ直結により JP 限定リレーが到達可能になるため。

候補構成（**最終確定は実装時のブラウザ到達性検証**による。§8）:

| リレー | 選定理由 |
|---|---|
| `wss://yabu.me` | **追加**。日本語圏アグリゲーター（複数国内リレーを集約）。本仕様の主目的 |
| `wss://nos.lol` | 高カバレッジ・日本語圏利用者も多い（継続） |
| `wss://relay.nostr.band` | 検索系。広域インデックス（単独依存しない、nostr-integration-spec §4.5）（継続） |
| その他（`relay.damus.io` / `relay.primal.net` / `nostr.hiroba.media`） | 非日本語著者カバレッジ。浏览器到達性・冗長性を見て最終構成で採否 |

`relay` Source は `source.id`（URL）を直接使用するため、本セットの変更影響を受けない（ユーザー指定の JP 限定リレーも浏览器から直接到達可）。

### 6.2 実行モデル（ブラウザ直接 WebSocket）

クライアントが nostr Source を処理するとき:

1. `TimelineCore` は Source が `provider='nostr'` のとき、`api.timeline` ではなく **`shared/nostr.ts` の `getTimeline(source, cursor, { wsFactory: browserWsFactory })`** を呼ぶ（ルーティングの詳細は §6.4）。
2. `browserWsFactory(url)` は `new WebSocket(url)` を生成し、`open` で resolve・`error` で reject する（`WsLike` へ適合）。
3. 以降は nostr-integration-spec §6.2 と**同一**: 固定セット（`pubkey`）または指定リレー1本（`relay`）へ並列 `REQ` → `EOSE` または全体4秒タイムアウトまで収集 → id 重複排除 → **schnorr＋id 再計算で全件検証** → `created_at` 降順 → ページサイズで切る → `nextCursor`。
4. Worker の outbound WS（`fetch` + `Upgrade`）は使用しない。`shared/nostr.ts` に Worker 専用 API を置かない（`wsFactory` は**必須引数**とし、既定ファクトリは持たない）。

### 6.3 プロフィール（kind 0）キャッシュ

nostr-integration-spec §6.4 の作法（インメモリ TTL 30分・lazy・sweep）を `shared/nostr.ts` のモジュール状態として継承する。**退化点**: BFF 時代の「全ユーザー共有」から「端末・セッション単位」になる。セッション内の複数 Source 横断では重複排除が効く。永続化はしない（§4.3）。

### 6.4 配管（クライアント / shared / Worker）

- **`shared/nostr.ts`（新規・単一ソース）**: `worker/src/nostr.ts` の純粋ロジックを移動。`NostrEvent` / `NostrFilter` / `WsLike` / `WsFactory` 型、`verifyEvent` / `toSegments` / `decodeNpub` / `shortenNpub` / `parseProfile` / `queryRelays` / `getTimeline` / `NOSTR_RELAYS` / プロフィールキャッシュ。**Worker 専用 API（`defaultWsFactory`）は移動しない**（`wsFactory` 必須化）。
- **クライアント（`app/`）**: `browserWsFactory` を用意。Source 取得のルーティングを追加: `provider==='nostr'` → `shared` の `getTimeline`（`browserWsFactory` 付き）、それ以外 → `api.timeline`。`TimelineResponse` 形状は不変なので、ADR-0004 の時系列合成・新着ピル・無限スクロールはそのまま。
- **Worker（`worker/src/index.ts`）**:
  - `worker/src/nostr.ts` を削除し、`nostrTimeline` import を除去。
  - `/api/timeline` の nostr 分岐を削除する。**ただし misskey へのフォールスルーを防ぐため、`provider==='nostr'` は明示的に `400`（例: `nostr is client-direct`）を返す**（§3.2）。
  - `KINDS.nostr = ['pubkey','relay']` と `isProvider` の nostr 受け入れは**維持**する。`/api/views`（`validateViews`）が nostr Source を含む View を引き続き検証するため（View の nostr Source はクライアントが直接描画する）。
  - `/api/sources` カタログに nostr を出さない・`/api/destinations` と Compose から nostr を除外、は継承（nostr-integration-spec §5.3 / §6.6）。
- **UI**: 自由入力（`Deck.tsx` の `parseNostrInput`）と Provider バッジ表示は継承。本文描画は統一 `Post` のまま無変更。

### 6.5 失敗の表出（Source 単位エラーの再利用）

ADR-0004 の部分障害耐性・`TimelineCore` の Source 単位エラー（`handleSourceError`）を再利用する。nostr 専用 UI は新設しない。

- **接続失敗と「接続成功・該当ゼロ」を区別する。** `WsFactory` の reject（`EOSE` 前の error/close）は接続失敗、`EOSE` 到達後の0件は「該当なし」。
- **`relay` Source（URL 1本）**: 接続失敗はその Source の**可視エラー**とする。メッセージには「このリレーは現在のネットワークから到達できない可能性があります」程度の**ネットワーク制限ヒント**を添える（JP 限定リレーの存在を踏まえた安価な配慮）。接続成功して0件はエラーではなく「投稿が見つかりません」扱い。次回ポーリングで再試行。
- **`pubkey` Source（複数リレー）**: 一部リレー不通は従来どおり**沈黙**（部分取得優先）。**全リレー失敗／0件**のときのみエラー。
- **エラーの型**: WS 失敗を `ApiError` 相当（`provider='nostr'`、`permanent` は立てない）へマップし、既存の Source エラーハンドリングに載せる。nostr に認証恒久失敗（`authFailed`）の概念は無い。

## 7. 受け入れ確認

- [ ] `npub` 自由入力の `pubkey` Source が、ブラウザ直接 WS で取得され、Bluesky/Misskey と同じ View 内で時系列合成されて描画される
- [ ] `wss://yabu.me` の `relay` Source が、**日本の住宅回線のブラウザから**新着を表示する（BFF 時代は到達不能だったもの）
- [ ] `/api/timeline?provider=nostr` は `400` を返す（misskey へフォールスルーしない）
- [ ] `/api/views` は nostr Source を含む View を引き続き検証・配信する
- [ ] 表示名・アバターが kind 0 から解決され、未取得時は npub 短縮に縮退する
- [ ] 本文中の画像 URL が Media、メンション・ハッシュタグ・`nostr:` リンクがセグメント描画される（統一 `Post` 不変）
- [ ] リポストが `repostedBy` 付きで表示され、参照先未取得時は表示されない
- [ ] 同一イベントが複数リレーから届いても重複しない
- [ ] 不正署名イベントがクライアントで破棄される（テストで偽イベント注入）
- [ ] 不通リレーの `relay` Source は可視エラー＋ネットワーク制限ヒントを表示し、他 Source は影響を受けず、次回ポーリングで再試行する
- [ ] `pubkey` Source は一部リレー不通でも部分表示し、全滅時のみエラー
- [ ] Compose / `/api/destinations` に nostr が現れない
- [ ] 4秒タイムアウト: 全リレー応答なしでも UI がハングしない

## 8. 実装時検証事項と拡張候補

### 8.1 実装時検証事項（オープン項目）

- **ブラウザからの JP 限定リレー到達性**: `yabu.me`（strfry）がブラウザの `Origin` ヘッダを拒否しないかを実ブラウザで確認（IP/ASN 制限はブラウザで満たせる想定）。
- **クライアントバンドルサイズ**: `@noble/curves`＋`@noble/hashes` 追加の実測（数十KB級の見込み）。
- **PWA（https）→ `wss://`** が問題なく張れること。
- **§6.1 の最終リレーセット構成**をブラウザ到達性で確定。

### 8.2 拡張候補（継承＋追加）

| 拡張 | トリガー | 備考 |
|---|---|---|
| nostr のオフライン最終成功表示 | オフラインで nostr を読みたい欲求が確定したとき | §4.6 / §7。クライアント側キャッシュ（IndexedDB 等）が別途要る。bluesky/misskey は SW キャッシュ有効 |
| NIP-65（著者の推奨リレーから取得） | nostr-integration-spec §4.4 を継承 | ブラウザ直結でも鶏と卵は同様 |
| `home` Source（kind 3 フォロー購読） | nostr-integration-spec §4.2 を継承 | 浏览器直結で複数リレー購読の負荷は端末側 |
| 投稿対応（Destination・nsec 管理） | 本人名義で書きたくなったとき | nostr-integration-spec §4.1。**独立 ADR 必須**。ブラウザ直結でも鍵管理の攻撃面は別問題 |

### 8.3 テスト方針（ADR-0001 / ADR-0002 準拠）

- `worker/src/nostr.test.ts`（署名検証・変換・`queryRelays`）を **`shared/nostr.test.ts` へ移動**。fake `WsFactory` 注入パターン（transport 非依存）を継承。
- クライアント側に**「nostr Source は `shared` の `getTimeline` へルーティングされ `/api/timeline` を叩かない」**ことを確認する薄いコンポーネント/ユニットテストを追加。
- 実ネットワーク接続・E2E は ADR-0001 に基づき行わない（実リレー到達性は §8.1 で人手検証）。`sw.ts` は測定外（ADR-0002）。
