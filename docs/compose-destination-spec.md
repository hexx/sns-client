# Compose の投稿先（Destination）選択 仕様書

> 新規投稿（Compose）の送信先を、各 Provider のホームと各 Misskey チャンネルから選べるようにする拡張の確定仕様。
> 作成: grill-with-docs セッション（全9問合意）に基づく。用語は [CONTEXT.md](../CONTEXT.md) 参照。

---

## 1. 背景・目的

- 現 `Compose` は **Provider 選択のみ**で、投稿先は常にその Provider のメイン TL（home）固定。Misskey チャンネルへ投稿する手段が無い。
- 「各ホーム・各チャンネルへ投稿したい」という要望を受け、投稿先の選択を導入する。
- 閲覧側には Source カタログ（`/api/sources`）が既に存在するが、**投稿先は書き込み側の概念**であり、候補集合も意味も異なる。本仕様は書き込み側を `Destination` として独立して定める。

## 2. スコープ

### 今回（確定）
- 投稿ごとに**単一の Destination** を選んで送信する（home / Misskey チャンネル）。
- 新用語 `Destination`、新エンドポイント `GET /api/destinations`、`PostInputWire.destination` の導入。
- Compose モーダルの Provider セレクトを Destination セレクトへ置換。
- reply/quote 時のチャンネル強制固定。

### 対象外（将来検討・v1 非対応）
- **クロスポスト（1投稿を複数 Destination へ同時送信）**。将来検討として記録する（§9）。
- チャンネルノートの quote 外部持ち出し（Misskey チャンネル設定 `allowRenoteToExternal`）。本仕様は**同チャンネル内 quote のみ**サポート。
- 任意チャンネルの検索・ID 直接指定（候補はリスト由来のみ）。
- 候補の出自バッジ（フォロー中 / お気に入りの区別表示）。
- Bluesky の home 以外の投稿先（list / feed はアグリゲーションで投稿概念が無い）。

## 3. ドメインモデル

### 新用語 `Destination`（CONTEXT.md 追加済み）

> **Destination**:
> 新しい Post の提出先（書き込み側）。`Source` と対になる概念で、`{provider, kind, id?}` と同じ形状を持つが、kind は投稿可能な種別（`home` / `channel`）に限られる（`list` / `antenna` / bsky `feed` は閲覧専用のため Destination にならない）。Compose は1つの投稿につき正確に1つの Destination を選ぶ。
> _Avoid_: target, 投稿先（識別子として）, to

- 形状は `Source` と同一（`{provider:'misskey', kind:'channel', id}` / `{provider:'bluesky', kind:'home'}`）。
- `Source`（読み側ストリーム）と混同しない。デッキの Source ピッカーと本仕様の Destination ピッカーは別機構。

## 4. BFF

### 4.1 `GET /api/destinations`

`/api/sources` と同型の**部分障害耐性カタログ**（片方 Provider が失敗しても他方は返す。`SourceCatalogEntry` と同構造の `DestinationCatalogEntry` を新設）:

```ts
export type DestinationOption = { destination: Destination; name: string };
export type DestinationCatalogEntry = { provider: Provider; options: DestinationOption[]; error?: boolean };
// GET /api/destinations → DestinationCatalogEntry[]
```

`Destination` は shared/types に追加:

```ts
export type Destination = { provider: Provider; kind: 'home' | 'channel'; id?: string };
```

**候補集合（Provider 別）:**

- **Bluesky**: `ホーム`（`{provider:'bluesky', kind:'home'}`）のみ。静的。
- **Misskey**: `ホーム`（静的）＋ チャンネル群（`📺 {name}`）。
  - チャンネル候補は **`channels/followed`（フォロー中）∪ `channels/my-favorites`（お気に入り）を id で重複排除**。
  - 並列取得（`Promise.all`）し、`listSources` のパターンを踏襲。

**決定の根拠（ADR ではなく本仕様に記録）:**
閲覧カタログ `/api/sources` がチャンネルを**お気に入りのみ**から出すのは「フォロー中は既にホーム TL に流れるため専用カラム化する価値が薄い」という*閲覧*文脈の判断（docs/misskey-channel-source-spec.md）。*投稿*文脈では逆で、Misskey のチャンネル「フォロー」は「そのチャンネルに参加・投稿する」ための仕組みであり、投稿先の本命はフォロー中チャンネル。お気に入り専用チャンネルへの投稿余地も残すため和集合とする。両カタログの集合差異は意図的である。

**頑健性:** home エントリは API 不要で静的に列挙できるため、チャンネル取得が失敗しても（`error: true`）home は常に返る。

### 4.2 `POST /api/post`（`PostInputWire.destination`）

```ts
export type PostInputWire = {
  provider: Provider;
  destination?: Destination; // 省略 = home。provider との一致を BFF が検証
  // ...既存フィールド不变
};
```

**BFF 検証ルール（違反は 400）:**
1. `destination.provider === provider`（不一致は拒否）。
2. `destination.kind` は投稿可能集合（`home` / `channel`）のみ。
3. `kind === 'channel'` なら `id` 必須。
4. `kind === 'channel'` かつ `provider !== 'misskey'` は拒否（Bluesky にチャンネルは無い）。

**Misskey 送信（`misskey.ts`）:** `notes/create` に `channelId = destination.id` を渡す（`kind === 'channel'` のときのみ）。

**Misskey サーバ仕様（事実・制約の記録）:**
- チャンネル所属ノートはサーバが `visibility = 'public'`・`localOnly = true` を**強制**する（クライアント値は上書きされる）。したがって BFF はチャンネル投稿時の `visibility` / `localOnly` を送っても無意味であり、フロントもこれらを送らない（§5.3）。
- アーカイブ済みチャンネルへの投稿は `NO_SUCH_CHANNEL` で拒否される。カタログ取得後にアーカイブされたケースで起こり得るが、既存の汎用失敗メッセージ（「送信に失敗しました。時間をおいてもう一度お試しください。」下書き保持）で扱う。個別メッセージは用意しない。
- チャンネルノートの quote（引用/renote）をチャンネル外へ行うと、チャンネルが `allowRenoteToExternal` を許可しない限り `CANNOT_RENOTE_OUTSIDE_OF_CHANNEL`。同チャンネル内 quote は常に許可。reply はサーバがチャンネルを自動継承。

**Bluesky 送信（`bsky.ts`）:** 不变。`destination` 省略または `kind:'home'` のみ受理。

### 4.3 後方互換

- `destination` 省略時は従来どおり home 投稿。既存クライアント・既存テストは不变。

## 5. フロント（`Compose`）

### 5.1 投稿先セレクタ

- 現 Provider セレクトを **単一 Destination セレクト**に置換。候補はフラットリスト（`optgroup` 分组は廃止）。ホーム候補のラベルは「**{Provider} · {name}**」、チャンネル候補は `📺 {name}`:

```
Bluesky · ホーム
Misskey · ホーム
📺 某チャンネル
📺 別チャンネル
```

- ラベル規則・ヘッダーの折り返し・中央揃え・隙間は [compose-header-layout-spec.md](./compose-header-layout-spec.md) による（§5.1 改訂: 旧来の「表示名は `name` のみ・optgroup 分组」は、閉じたセレクトから Provider を識別できないため廃止）。
- 候補が1つのみ（configured Provider が1つでチャンネル無し）の場合はセレクタを非表示（現 UI の最適化を継承）。
- 候補の取得元: `GET /api/destinations`。ただし **home エントリはカタログ失敗時も configured Provider 分を静的に生成**して常に提供する（チャンネルだけ欠け得る）。
- 表示ラベルはクライアント側で `PROVIDER_LABEL` から合成する（BFF の `name` フィールドは不変）。

### 5.2 永続化

- 前回選択を `localStorage` キー **`compose-destination`** に Destination JSON で保存。
- 起動時: 保存値が有効（候補に存在）ならそれを、無ければ先頭候補を既定にする。
- 旧キー `compose-target`（Provider 文字列）は読み取らない（新キーへ移行。旧キーの削除は任意）。

### 5.3 チャンネル選択時の visibility / ローカルのみ

- `destination.kind === 'channel'` のとき、visibility セレクトとローカルのみ checkbox を**非表示**にし、注記を1行表示:
  > チャンネル投稿は公開・ローカルのみ（Misskey 仕様）
- このとき wire に `visibility` / `localOnly` を載せない。
- `kind === 'home'`（Misskey）の場合は現 UI・現 wire を维持。

### 5.4 reply/quote 時の強制固定

- 現行の「reply/quote は対象 Provider に固定」を **「対象 Destination に固定」へ拡張**する。
- `replyTo` / `quote` の Post が `channel` を持つ（Misskey チャンネルノート）場合、Destination を `{provider:'misskey', kind:'channel', id: post.channel.id}` に固定し、セレクタの代わりに固定表示（例:「📺 {チャンネル名} へ投稿」）。
- チャンネルを持たない Post の場合は Provider 固定（home）——現行挙動と同じ。
- 根拠: Misskey サーバが quote に同チャンネルを強制し、reply を自動継承するため、選択余地が無い（§4.2）。

### 5.5 他 UI への影響

- **デッキ UI（docs/deck-compose-spec.md）**: フロートボタン＋トーストの接続は不变。`Compose` 内部が変わるだけ。
- **タブ UI**: reply/quote 導線（PostCard）は不变。チャンネルノートからの reply/quote が §5.4 で自動的にチャンネル固定になる。

## 6. 非目標（v1）

クロスポスト（複数 Destination 同時送信）／チャンネル quote の外部持ち出し／任意チャンネル検索・ID 指定／出自バッジ／Bluesky の home 以外の投稿先／投稿後のカラム強制リフレッシュ（ポーリング模型维持）。

## 7. テスト方針

既存の vitest パターン（worker: BFF、app: コンポーネント）に従う。

- **worker**:
  - `POST /api/post` の `destination` 検証4ルール（provider 不一致 / 不正 kind / channel で id 無し / bsky+channel → 400）。
  - misskey `notes/create` への `channelId` 受け渡し（channel 指定時あり・home 時無し）。
  - `GET /api/destinations`: misskey のフォロー中 ∪ お気に入り和集合・id 重複排除・`📺` 名前付け・home 静的エントリ・片方 Provider 失敗時の部分障害耐性。
- **app（`Compose`）**:
  - Destination セレクトの描画（optgroup・候補1つで非表示）。
  - チャンネル選択で visibility/ローカルのみが隠れ注記が出る。
  - reply/quote がチャンネルノートのとき Destination 固定表示。
  - `compose-destination` 永続化とフォールバック。

## 8. 既存文書との関係

- [sns-client-spec.md](./sns-client-spec.md): 最上位仕様。`/api/post` の契約拡張は本仕様が定める（同仕様の API 表は MVP 期の最小表記で、`/api/sources` 等も未掲載。本仕様を参照）。
- [deck-compose-spec.md](./deck-compose-spec.md): デッキからの Compose 起動。本仕様による `Compose` 内部変更の影響を受けない（§5.5）。
- [misskey-channel-source-spec.md](./misskey-channel-source-spec.md): 閲覧側チャンネル Source 化。候補集合の差異の根拠は §4.1 に記録。
- [misskey-channel-display-spec.md](./misskey-channel-display-spec.md): `Post.channel` と 📺 チップの表示機構。§5.4 の固定表示が `post.channel.name` を利用。
- [CONTEXT.md](../CONTEXT.md): `Destination` 用語を追加済み。
- **ADR: 作成しない。** 本拡張の決定（単一 Destination、和集合カタログ、wire 形状）は撤回可能・文書内で根拠説明済・実質的代替案を本文に記録済みのため、ADR の三条件（撤回困難・文脈無しで驚き・実質的トレードオフ）を同時に満たさない。和集合 vs お気に入り再利用のトレードオフは §4.1 に記録した（source-spec の前例に倣う）。

## 9. 将来検討: クロスポスト（B）

1投稿を複数 Destination へ同時送信する拡張。本仕様の単一 Destination 契約（A）を確定した上で、必要になったら検討する。検討時に扱う論点（想定）:

- `PostInputWire` を複数ターゲット契約へ引き直す（部分成功の扱い: 片方だけ失敗したときの UI とリトライ）。
- Misskey チャンネル投稿の visibility 強制と、Provider 横断の同一下書きで揃わない制約の吸収。
- A→B は拡張として自然だが、B→A は縮小で痛いため、当面は A を維持する。
