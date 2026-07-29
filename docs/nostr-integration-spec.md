# Nostr 統合の可否と読み取り専用 Provider の仕様

> 複数 SNS を1画面で扱う PWA クライアント（[sns-client-spec.md](./sns-client-spec.md)）への
> **Nostr 対応の可否と範囲を確定した仕様**。結論: **`nostr` を読み取り専用 Provider として統合する。投稿（nsec 管理）は一切しない。BFF がリレー群へリクエスト単位で WebSocket を開き、イベントを `Post` に変換して既存の統合タイムラインに混ぜる**。
> 作成: grill-with-docs セッション（全7問合意）に基づく。
> 関連 ADR: [ADR-0013](./adr/0013-nostr-readonly-provider.md)。用語は [CONTEXT.md](../CONTEXT.md) 参照。

---

## 1. 背景・問い

「Nostr 対応ってどこまでできるのか？」を確定する。

欲求の中身は grilling により **「界隈で名前を見るので、対応できると嬉しいのか知りたい」段階（動機は探索的）** と確定した。このためスコープを **「特定の Nostr ユーザー／コミュニティリレーの投稿を、Bluesky / Misskey と同じ統合タイムラインで読む」（閲覧のみ）** に絞る。本人名義の投稿（書き込み）は本セッションのスコープ外。

## 2. 結論

1. **`nostr` を Provider として統合する（読み取り専用）。** `Provider` union に `'nostr'` を追加する。mixi2 のような型予約ではなく実装を伴う統合だが、**Destination は持たない**（投稿不可）。`ProviderInfo.configured` は常に `true`（認証不要）。
2. **Source は2種別。** `pubkey`（特定ユーザーの投稿＋リポスト）と `relay`（コミュニティリレーのローカル TL 相当）。
3. **BFF がリレー群へリクエスト単位で WebSocket を開く。** ブラウザ直接接続・Durable Object 常時購読は採用しない。`TimelineResponse` 契約は不変で、UI の Provider 別分岐は描画バッジ程度。
4. **鍵（nsec）は一切扱わない。** 閲覧は署名不要なため、NIP-07 / NIP-46 / nsec 入力のいずれも実装しない。

## 3. 事実根拠

### 3.1 Nostr プロトコルの要点（NIP-01 中心）

- **アカウント＝鍵ペア。** 公開鍵（32バイト、`npub1...` はその bech32 编码）がユーザー識別子。秘密鍵（`nsec...`）でイベントに署名する。登録・パスワード・サーバアカウントは存在しない。
- **リレー＝WebSocket の配信サーバ。** 世界中に数百〜数千あり誰でも立てられる。リレーはイベントを預かって流すだけで、フォロー関係もタイムラインも**サーバ側には存在しない**。クライアントが自分でタイムラインを構成する。
- **イベント＝署名付き JSON。** `kind` で種別が決まる。本仕様で扱うのは下記。

| kind | 意味 | 本仕様での扱い |
|---|---|---|
| 0 | プロフィール（`display_name` / `name` / `picture` / `nip05` の JSON を `content` に持つ） | `Author` 解決に使用（§6.4） |
| 1 | テキスト投稿 | `Post` 本体 |
| 6 | リポスト（`e` タグで元ノートを参照） | `Post.repostedBy` として包む（§6.5） |
| 3 | フォローリスト | **MVP 対象外**（`home` Source 拡張候補、§8） |
| 7 | 絵文字リアクション | **MVP 対象外**（§4.3） |
| 9735 | zap（Lightning 投げ銭） | **MVP 対象外**（§4.3） |
| 10002 | 推奨リレー宣言（NIP-65） | **MVP 対象外**（§4.4 / §8 再審トリガー） |

- **スレッド・参照の規約**: NIP-10（`e` タグの `root`/`reply` マーカーによる返信構造）、NIP-18（引用: `q` タグ／本文中 `nostr:note1...`）、NIP-21/27（本文中の `nostr:` URI とメンション）、`t` タグ（ハッシュタグ）、`content-warning` タグ（CW）。
- **読み取りに認証は不要。** リレーは通常、購読（`REQ`）に鍵を要求しない。これが「閲覧のみなら鍵不要」の根拠。
- **同一イベントが複数リレーに存在する。** イベント id（64hex、SHA-256）で一意。複数リレーから重複して届くため id による重複排除が必須。

### 3.2 Threads（ADR-0011）との決定的な違い

Threads は ActivityPub を話すため Misskey 連合が投稿を運んできた（コード変更ゼロ）。**Nostr は ActivityPub ではない**ため「連合で吸収」は不可能で、リレー接続・署名検証・イベント→Post 変換の自前実装が必須。つまり本件は ADR-0011 型ではなく、Provider 統合（ただし読み取り専用）となる。

## 4. 却下・対象外とした案

### 4.1 投稿対応（nsec 管理）— 対象外

動機が探索的（§1）であること、投稿を有効にすると NIP-07 拡張／nsec 直接入力／NIP-46 リモート署名のいずれかによる**秘密鍵管理が不可避**で、現状「BFF が OAuth トークンを扱うだけ」のアプリに段違いの攻撃面と説明責任が加わることが理由。閲覧の機構は投稿を前提としないため、将来の追加は独立した ADR で行える。

### 4.2 `home` Source（自分の kind 3 フォロー購読）— 対象外（拡張候補）

自分の npub の kind 3 を読めば鍵不要で「自分の Nostr ホーム TL」を構成できるが、数百 pubkey のフィルタを複数リレーに投げる重い処理になる。`pubkey` Source の機構（§5）の上位互換なので、必要になったら載せる（§8）。

### 4.3 reaction（kind 7）・zap（kind 9735）の取り込み — 対象外

主流クライアント（Damus / Amethyst / Primal）はこれらを**フィード項目として並べず、ノートへの注釈（数・額）として表示**する。注釈表示にはノートごとの第2段クエリ（NIP-45 COUNT 等、リレー対応はまちまち）が必要。さらに zap は Bitcoin/Lightning という**本アプリの用語集に存在しない新ドメイン**を持ち込む。MVP の `Post.stats` は `{0,0,0}` 固定とする。

### 4.4 NIP-65 準拠のリレー解決 — 対象外（再審トリガー付き）

著者の kind 10002（推奨リレー宣言）を引いてからそのリレー群に問い合わせる方式は正確だが、「kind 10002 をどこから引くか」が鶏と卵で、ラウンドトリップも倍になる。固定リレーセット（§6.1）で実用上足りると判断。**再審トリガー＝固定セットで投稿を取得できないユーザーが出てきたとき**（mixi2 ADR-0009 の書き方に倣う）。

### 4.5 検索リレー単独依存 — 却下

`relay.nostr.band` 等のネットワーク全体クロールリレー1本で済ます案は、単一の第三者サービス依存（停止で全滅）となり、各 Provider を直接叩く本アプリの設計思想と矛盾するため却下。固定セットの**構成要素の1つ**として使うのは可（§6.1）。

### 4.6 ブラウザ直接接続 / Durable Object 常時購読 — 却下

実行モデルの比較は [ADR-0013](./adr/0013-nostr-readonly-provider.md) に記録。要旨: ブラウザ直接接続は「UI は BFF とだけ話す」原則（ADR-0005 の変換責務を含む）を Nostr だけ破る負債、Durable Object はポーリング＋ピルの既存 UX（[CONTEXT.md](../CONTEXT.md) の Timeline）を変えずにインフラだけ増えるため却下。

### 4.7 NIP-05 識別子の表示 — 対象外（拡張候補）

kind 0 の `nip05`（`jack@cash.app` 形式）は自己申告で、検証にはドメインごとの `/.well-known/nostr.json` 取得機構が要る。未検証表示は詐称に加担しかねないため MVP では行わず、`handle` は npub 短縮（§6.4）。検証付き NIP-05 は拡張候補（§8）。

### 4.8 引用の埋め込み — 対象外（拡張候補）

NIP-18 の引用を `Post.quote` として埋め込むには参照イベントの追加 fetch が必要（別リレー・削除済みで失敗しがち）。MVP ではリンクセグメント表示に留める（§6.3）。`Post.quote` の機構は既存のため、拡張は局所作業。

## 5. ドメインモデル対応

### 5.1 Source

| Source kind | id | 取り込むイベント | 意味 | 既存の相当 |
|---|---|---|---|---|
| `pubkey` | `npub1...`（bech32） | kind 1 ＋ kind 6 | そのユーザーの投稿とリポスト | Bluesky home 相当 |
| `relay` | `wss://...` | kind 1 のみ | コミュニティリレーのグローバル新着＝ローカル TL 相当。他人のリポストはノイズのため除外 | Misskey LTL 相当（本アプリ初） |

- 形状は既存の `Source = { provider, kind, id? }` そのまま（`kind` は自由文字列）。`Provider` union への `'nostr'` 追加のみで済む。
- **両 kind とも id 必須**。Worker の Source バリデーション（既存テスト「kind 不正」「id 必須の kind で id 無し」の機構）に `nostr` の2種を追加する。
- `Destination` は定義しない（`'home' | 'channel'` 制限に抵触せず、そもそも書き込み無し）。

### 5.2 イベント → `Post` 変換

| Nostr の要素 | → Post 対応 | 備考 |
|---|---|---|
| kind 1 `content` | `text` ＋ `RichSegment[]` | 下記セグメント規則 |
| `https://...` URL | `link` セグメント | 既存と同型 |
| `nostr:npub1...` メンション（NIP-27） | `mention`（handle=npub 短縮、`url` なし） | §6.4 と同じく解決は最小 |
| 本文中 `#タグ`（`t` タグ相当） | `hashtag` セグメント | 本文中の `#` を検出（Misskey 扱いと同型） |
| 本文中の画像 URL（.jpg/.jpeg/.png/.gif/.webp） | `media[]` にリフトアップし本文からは除去 | alt なし（Nostr に alt 概念が無い欠落は許容）。拡張子スニッフィングの偽陽性は許容リスク |
| 引用（`nostr:note1/nevent1`、NIP-18 `q` タグ） | `link` セグメント（埋め込みしない） | §4.8 |
| `content-warning` タグ | 無視 | `Post` に CW フィールド自体が無い。kind 1 での使用は稀 |
| リプライ（NIP-10 root/reply マーカー付き kind 1） | 通常ポストとして表示 | 返信コンテキストは表示しない（`Post` に root/parent 字段無し）。**既知の制限** |
| kind 6（リポスト） | 参照先 kind 1 を `ids` でバッチ fetch し `repostedBy`=kind 6 著者で包む | 参照先が取得不能（別リレー・削除済み）なら**そのリポストはスキップ**（§6.5） |
| `stats` | `{ replies: 0, reposts: 0, likes: 0 }` 固定 | §4.3 |
| `id` | イベント id（64hex） | |
| `ref` | イベント id（64hex） | 閲覧のみなので自己参照は id と同一で十分 |
| `createdAt` | `created_at`（unix 秒）→ ISO 8601 | |
| `visibility` / `channel` / `linkCard` / `quote` / `viewer` | 設定しない | Nostr に对应概念が無い、または対象外 |

### 5.3 Provider 特性

- `ProviderInfo.configured`: **常に `true`**（シークレット不要で使える初の Provider）。
- `ProviderInfo.compose`: **任意（`compose?`）へ型変更**。nostr は投稿不可のため compose を持たない。UI は「compose 無し → Compose の Provider 選択・`/api/destinations` から除外」とガードする。将来の投稿対応時は compose を追加すれば自然に復活する。

## 6. 実装方式

### 6.1 固定リレーセット

`pubkey` Source の問い合わせ先（および kind 0 取得先）は以下の固定セットとする。グローバルなカバレッジの大きいリレーと日本語圏コミュニティリレーの混合。

| リレー | 選定理由 |
|---|---|
| `wss://relay.damus.io` | 最大級のカバレッジ（Damus 既定） |
| `wss://nos.lol` | 高カバレッジ・日本語圏利用者も多い |
| `wss://relay.nostr.band` | 検索系リレー。ネットワーク広域のインデックスを保持（単独依存はしない、§4.5） |
| `wss://relay.primal.net` | Primal 運用の高カバレッジリレー |
| `wss://nostr.hiroba.media` | 日本語圏コミュニティリレー（`relay` Source の既定候補としても案内） |

セットはコードに定数として固定する。変更・拡張（NIP-65 含む）の条件は §8。

### 6.2 実行モデル（BFF リクエスト単位 WebSocket）

`/api/timeline` が nostr Source を処理するとき:

1. 固定セット（`pubkey`）または指定リレー1本（`relay`）へ **outbound WebSocket を並列に開く**（Cloudflare Worker の outbound WS を使用）。
2. 各リレーに NIP-01 `REQ` を送る。
   - `pubkey`: `{ kinds: [1, 6], authors: [<pubkey hex>], until: <cursor>, limit: <ページサイズ+余裕> }`
   - `relay`: `{ kinds: [1], until: <cursor>, limit: <ページサイズ+余裕> }`
   - `npub1...` は decode して hex pubkey に変換してから使う（bech32、NIP-19）。
3. **各リレーの `EOSE`（End Of Stored Events）または全体で 4秒タイムアウト**までイベントを収集し、接続を閉じる。
4. 収集イベントを**イベント id（64hex）で重複排除**（同一イベントの複数リレー由来分を統合）。
5. **全イベントの署名を schnorr（`@noble/curves`）で検証**し、不正イベントは破棄する（悪意リレーの偽イベント注入対策。1件あたりサブミリ秒級）。`id` の再計算（シリアライズ後の SHA-256）も併せて検証する。
6. `created_at` 降順にソートし、ページサイズで切る。`nextCursor` = 返却ページ最古の `created_at`（unix 秒の文字列）。Nostr に opaque カーソルが無いため `until` で代用する。境界重複は id 重複排除で吸収する。

### 6.3 本文のリッチテキスト化（ADR-0005 準拠）

kind 1 `content` を走査し、`RichSegment[]` を生成する:

- `nostr:npub1...` / `nostr:nprofile1...` → `mention`（handle=npub 短縮）
- `nostr:note1...` / `nostr:nevent1...` → `link`（テキストは短縮表記。外部 URL を持たないため `url` は省略可）
- `https?://...` → 画像拡張子で終われば `media[]` へリフト（本文から除去）、それ以外は `link`
- `#タグ` → `hashtag`
- 残りは `text`

`p` / `e` タグのうち本文中に現れない暗黙の参照は描画しない（MVP）。

### 6.4 Author 解決（kind 0）

- 同一セッションで `REQ { kinds: [0], authors: [...] }` を送りバッチ取得する（`relay` Source は著者が多数のため必須）。
- キャッシュは **ADR-0006（絵文字レジストリ）と同じ作法**: インメモリ TTL 30分・シングルフライト・lazy 取得。キーは pubkey hex。
- マッピング: `displayName` = `display_name || name`（無ければ handle）、`handle` = **npub 短縮**（先頭8文字＋`…`＋末尾4文字程度）、`avatarUrl` = `picture`。
- kind 0 未取得・取得失敗時はフォールバック: `displayName` = handle、`avatarUrl` = undefined（非致命、Misskey 絵文字解決と同様の縮退）。

### 6.5 kind 6（リポスト）の処理

1. ページ内の kind 6 イベントの `e` タグから参照先イベント id を集める。
2. `REQ { kinds: [1], ids: [...] }` を同一セッション（または直後の追加セッション）でバッチ fetch。
3. 取得できたものだけ、`repostedBy` = kind 6 著者の `Post` として組み立てる。**未取得の kind 6 はスキップ**（ログは残すが利用者には見せない）。

### 6.6 配管（Worker / 共有型 / UI）

- `shared/types.ts`: `Provider` union に `'nostr'` 追加。`ProviderInfo.compose` を `compose?: ComposeConfig` に任意化。
- Worker: nostr 用 timeline ハンドラ（§6.2）と kind 0 解決、Source バリデーション（`pubkey`/`relay`・両方 id 必須）を追加。`/api/sources` のカタログには nostr エントリを**出さない**（セッション由来の選択肢が無いため。追加は自由入力経由、下記）。
- `/api/destinations` と Compose の Provider 選択から nostr を除外（`compose` 無しのガードで自然に実現）。
- UI: Source ピッカーに**自由入力欄**を追加。入力値の形式で kind を判定: `npub1...`（または `nprofile1...`）→ `{ provider: 'nostr', kind: 'pubkey', id }`、`wss://...` → `{ provider: 'nostr', kind: 'relay', id }`。アドレス帳・プリセット管理は MVP では持たない。
- UI 描画: Provider バッジ（nostr 表示）以外は既存の Post 描画をそのまま使用。

## 7. 受け入れ確認

- [ ] `npub` を自由入力して作った `pubkey` Source が、Bluesky/Misskey と同じ View 内で時系列合成されて描画される
- [ ] `wss://nostr.hiroba.media` の `relay` Source がローカル TL 的に新着を表示する
- [ ] 表示名・アバターが kind 0 から解決され、未取得時は npub 短縮に縮退する
- [ ] 本文中の画像 URL が Media として描画され、メンション・ハッシュタグ・`nostr:` リンクがセグメント描画される
- [ ] リポストが `repostedBy` 付きで表示され、参照先未取得時は表示されない（エラーにならない）
- [ ] 同一イベントが複数リレーから届いても重複して表示されない
- [ ] 不正署名のイベントが破棄される（テストで偽イベント注入）
- [ ] Compose の Provider 選択・`/api/destinations` に nostr が現れない
- [ ] 4秒タイムアウト: 全リレー応答なしでも空ページ（`nextCursor: null` 相当）で戻り、UI がハングしない

## 8. 拡張候補と再審トリガー

| 拡張 | トリガー | 備考 |
|---|---|---|
| NIP-65（著者の推奨リレーから取得） | 固定セットで投稿を取得できないユーザーが出てきたとき | §4.4。固定セットの機構を壊さず1段階挟むだけ |
| `home` Source（kind 3 フォロー購読） | 「自分の Nostr TL を混ぜたい」欲求が確定したとき | §4.2。`pubkey` 集合の購読として実現可 |
| NIP-05 識別子（検証付き） | npub 短縮の識別性が不満になったとき | §4.7。well-known 取得＋キャッシュ機構が別途要る |
| 引用の埋め込み（`Post.quote`） | リンク表示では物足りなくなったとき | §4.8。参照イベント fetch の失敗耐性が要る |
| reaction 数・zap 額の注釈 | stats ゼロが不満になったとき | §4.3。NIP-45 COUNT 対応リレーへの依存。zap はドメイン用語の追加を伴う |
| 投稿対応（Destination・nsec 管理） | 本人名義で書きたくなったとき | §4.1。**独立した ADR を必須とする**（NIP-07 / NIP-46 / nsec 入力の三択は本セッションで検討していない） |
