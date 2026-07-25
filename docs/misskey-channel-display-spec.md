# Misskey チャンネル投稿の識別表示 仕様

フォロー中チャンネルのノートは Misskey のホーム TL（`notes/timeline`）に流れてくるため、統合ホームでも通常投稿と混在する。現状は見た目が区別できず「どのチャンネルから来た投稿か」が分からない。本仕様は、統一 `Post` モデルにチャンネル情報を載せ、PostCard のヘッダにチャンネル名チップを表示する。**表示のみ**（チャンネルへの投稿・フィルタ等は対象外）。

## 前提事実（Misskey API）

- Misskey のホーム TL は「フォロー中のユーザー＋フォロー中のチャンネル」のノートで構成される。つまりチャンネル投稿は既存の `notes/timeline` 取得経路に既に混ざっている。
- packed Note エンティティにはデフォルトで `channelId` と `channel: { id, name, color, isSensitive, allowRenoteToExternal, userId }` が載る（追加パラメータ不要。`NoteEntityService.pack` で確認済み）。
- チャンネルノートは、チャンネルの `allowRenoteToExternal` が許可している場合、チャンネル外へ通常リノートされ得る（このとき外側のリノート活動には `channel` が付かない）。

## 用語（`CONTEXT.md` 反映済み）

- **Channel**: 投稿が所属する Misskey チャンネル（ノートが投下されるコミュニティ）。Post は `{id, name}` を保持し、UI は名前を表示して通常投稿と見分ける。Source の実現形態としての channel（チャンネルタイムラインというストリーム）とは別概念。
  _Avoid_: group, community, circle

## ドメインモデル（`shared/types.ts`）

```ts
export type Post = {
  // ...既存フィールド
  visibility?: Visibility; // 任意（Misskey）
  localOnly?: boolean; // 任意（Misskey）
  channel?: { id: string; name: string }; // 任意（Misskey）。投稿が所属するチャンネル
};
```

- `visibility` / `localOnly` / `reactions` と同じ「Misskey 固有の任意属性」の流儀。Bluesky 投稿には載らない。
- `id` は MVP では未使用。将来のディープリンク（`{instance}/channels/{id}`）やフィルタに備えて保持する。
- 省略可能フィールドの追加なので wire 互換性は保たれる（既存クライアント・旧キャッシュ payload への影響なし）。

## BFF マッピング（`worker/src/misskey.ts`）

### 生データ型

```ts
type MkNote = {
  // ...既存フィールド
  channel?: { id: string; name: string } | null; // 使うのは id/name のみ（color 等は破棄）
};
```

### 基本規則

`basePost` がノート自身の `channel` を映射する:

```ts
if (note.channel) post.channel = { id: note.channel.id, name: note.channel.name };
```

引用（`post.quote = basePost(note.renote)`）も同じ経路で機械的に載る。引用カードへの**表示はしない**が、データは保持する（将来対応時の追加コストゼロ）。

### 純粋リノートの規則: 外側優先（`外側 ?? 内側`）

純粋リノートは内側ノートが表示主体になるが、チャンネルは**外側（リノート活動）を優先し、無ければ内側（コンテンツの出身）**を採用する:

```ts
const post: Post = { ...inner, id: note.id, createdAt: note.createdAt, repostedBy: ..., source: note };
if (note.channel) post.channel = { id: note.channel.id, name: note.channel.name };
// 外側が無ければ ...inner に展開された内側の channel がそのまま残る
```

| ケース | 外側（活動） | 内側（コンテンツ） | 表示されるチップ | 根拠 |
|---|---|---|---|---|
| A: チャンネルノートの外部リノート | 無し | チャンネル X | X | コンテンツの出身が流れてきた理由 |
| B: チャンネル内リノート | チャンネル X | チャンネル X | X | どちらでも一致 |
| C: 通常ノートをチャンネル内リノート | チャンネル X | 無し | X | 活動が TL に現れた理由 |

チップの役目は「なぜこの投稿が自分のタイムラインにあるか」の説明であるため、3ケースすべてでチャンネル X が表示されるこの規則を採用する。「明らかにチャンネル由来なのにチップが出ない」ケース（C の内側優先採用時）を生まない。

## レンダリング（`app/src/components/PostCard.tsx`）

- **配置**: card-head の**時刻の隣**（Misskey Web 公式と同じ慣習）。`repostedBy` バッジの有無に関わらず表示する。
- **構造**:

```tsx
{post.channel && (
  <span className="channel-chip" title={post.channel.name}>
    📺 <span className="channel-name">{post.channel.name}</span>
  </span>
)}
```

- **MVP ではクリック不可**（リンク無し）。`id` はモデルに保持済み。
- **長い名前**: チャンネル名は最大128文字。`max-width: 12em` + `text-overflow: ellipsis` で省略し、`title` 属性でフルネームを補完する。card-head の高さは一定に保つ（折り返し禁止）。
- **チャンネル無し投稿**（Bluesky 投稿・Misskey 通常投稿）は何も描画せず、既存表示と完全互換。
- **QuoteCard には出さない**。引用カードは最小プレビュー（時刻・stats も省略する既存方針）であり、所属表示は本体カードの責務。1カードにチップが2つ並ぶ情報過多を避ける。

## テスト（ADR-0001 / ADR-0002 準拠）

- `worker/src/misskey.test.ts`（`mapNote` のチャンネル映射）
  - チャンネル付きノート → `post.channel = { id, name }`（`color` 等の余剰フィールドは載らない）
  - チャンネル無しノート → `channel` フィールド自体が存在しない
  - 純粋リノート・ケース A（外側無し・内側 X）→ チップ X（内側フォールバック）
  - 純粋リノート・ケース B（外側 X・内側 X）→ X
  - 純粋リノート・ケース C（外側 X・内側無し）→ X（外側優先の回帰固定）
  - 引用（外側チャンネル X、引用先チャンネル Y）→ 外側 `channel: X` かつ `quote.channel: Y`
- `app/src/components/PostCard.test.tsx`（レンダリング）
  - `channel` 有り → チップが名前・`title` 属性付きで描画される
  - `channel` 無し → チップ要素自体を描画しない
  - `repostedBy` 有り＋`channel` 有り → チップが描画される（ケース A の表示回帰）
  - `quote.channel` 有り → QuoteCard 内にチップを描画しない（対象外を回帰防止で固定）
- CSS の省略記号（`text-overflow`）は ADR-0002 のテスト境界に従い視覚確認に留める

## 対象外（明示）

1. **チャンネルへの投稿（compose）** — `PostInputWire` への `channelId` 追加とチャンネル選択 UI。投稿先選択は別デザイン（チャンネル一覧取得 API 等）が必要。
2. **チャンネル単位のフィルタ/ミュート** — 表示による需要確認が先。
3. **チャンネルタイムラインの Source 化** — `kind: 'channel'` の Source を View に足す機能。既存 Source 機構で自然に載るが、本仕様の課題（ホーム TL に混ざる投稿の識別）とは別チケット。
4. **チップのクリック遷移** — `{instance}/channels/{id}` へのディープリンク。複数インスタンス対応時のインスタンス URL 解決が絡むため後回し。`channel.id` は確保済み。

## ADR

不要。「変更不要 × 文脈なしで驚き × 本当のトレードオフ」の3条件を同時に満たす判断が無いため（任意フィールドの追加と表示チップは容易に変更可能）。
