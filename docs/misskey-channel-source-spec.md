# Misskey チャンネルタイムラインの Source 化 仕様

お気に入りチャンネルのタイムラインを、デッキの1カラム（Source）として閲覧する機能。`docs/misskey-channel-display-spec.md` の「対象外 3. チャンネルタイムラインの Source 化」を引き受ける後続仕様である。表示チップ（📺）の機構は同仕様のものを再利用し、本仕様は**ストリームの取得と選択 UI** を定める。

## 背景と動機

- Misskey のチャンネル「フォロー」はホーム TL にノートを流すだけのスイッチであり、デッキでチャンネル単位に閲覧したい場合はホームとの混在を許容するしかなかった。
- Misskey の「お気に入り」はチャンネルを自分の一覧にブックマークする機構で、**Misskey Web のデッキ UI はお気に入りからチャンネルカラムを追加する**流儀（フォローとお気に入りは独立。misskey.io サポートの議論で確認）。
- 本クライアントもこれに倣い、お気に入りチャンネルを Source として選択可能にする。「ホームにごちゃ混ぜにせず、特定のチャンネルをじっくり見る」のが主ユースケース。

## ドメインモデル

既存用語で表現でき、`CONTEXT.md` の変更は不要:

- **Source**: `{ provider: 'misskey', kind: 'channel', id: channelId }`。用語集が想定済みの「Source の実現形態としての channel（チャンネルタイムラインというストリーム）」そのもの。
- **Channel**: 取得されるノートには既存の `Post.channel = {id, name}` が載り、PostCard に 📺 チップが描画される（`misskey-channel-display-spec.md` の機構をそのまま利用）。

## BFF（`worker/src/misskey.ts` / `worker/src/index.ts`）

### 取得 dispatch

`getTimeline` に `kind === 'channel'` 分岐を追加する。ページングは他種別と共通（`untilId`、`limit: LIMIT`）:

```ts
} else if (source.kind === 'channel') {
  if (!source.id) throw new MisskeyApiError(400, 'channel source requires id');
  endpoint = 'channels/timeline';
  params.channelId = source.id;
}
```

- `channels/timeline` が返す packed Note には `channel` が載るため、`mapNote` 経由で `Post.channel` が機械的に設定され、チップ表示は追加実装なしで機能する。
- ホーム Source とチャンネル Source を同じ View に混ぜて同一ノートが両方に現れ得るが、フロントの `TimelineCore` が `seenIds`（投稿 ID 単位）で重複排除するため表示上の問題はない。

### kind 許可リスト

`worker/src/index.ts` の `KINDS` を更新:

```ts
misskey: ['home', 'list', 'antenna', 'channel'],
```

これにより `/api/timeline` と `PUT /api/views` の検証（`kind !== 'home'` には `id` 必須）が自動的に `channel` へ適用される。

### カタログ（`listSources`）

`users/lists/list`・`antennas/list` の並列取得に `channels/my-favorites` を加える:

```ts
const [lists, antennas, favorites] = await Promise.all([
  mkApi<{ id: string; name: string }[]>(env, 'users/lists/list'),
  mkApi<{ id: string; name: string }[]>(env, 'antennas/list'),
  mkApi<{ id: string; name: string }[]>(env, 'channels/my-favorites', { limit: 100 }),
]);
for (const c of favorites) {
  options.push({ source: { provider: 'misskey', kind: 'channel', id: c.id }, name: `📺 ${c.name}` });
}
```

- **候補集合は `channels/my-favorites`（お気に入り）であり `channels/followed`（フォロー中）ではない**。フォロー中チャンネルは既にホーム TL に流れてくるため、専用カラム化する価値が薄い。お気に入りは「TL には流さないが一覧として保持したい」チャンネルの受け皿であり、Misskey Web デッキの流儀とも一致する（決定の根拠。ADR にはせず本仕様に記録する）。
- **`limit: 100`（API 最大）の1ページ分のみ取得**。100 件超のページングは行わない（下記「対象外」）。
- ラベルは `📺 ${name}`。PostCard チップと同じ 📺 を使うことで「📺 付き = チャンネル」がアプリ全体で一貫した視覚言語になる。
- お気に入りが空ならチャンネルの選択肢は出ない（既存のエラー/空状態の流儀に従う）。

## フロント（`app/src/components/Deck.tsx`）

- ソースピッカーは既存のチェックボックスリストをそのまま使う。Misskey フィールドセット内に `📺 チャンネル名` の選択肢がフラットに並ぶ（リスト/アンテナと同列）。グループ化（サブ見出し）は MVP では行わない。
- 選択肢の種別バッジ（`KIND_LABEL`）に `channel: 'チャンネル'` を追加する（未定義だと素の `channel` 文字列が描画される）。
- **チャンネル専用カラム内でもチップは常に表示する**。PostCard は View の Source 構成を知らず、抑制ロジックはコンポーネント境界を汚すため採用しない。Misskey Web もチャンネル TL 内でチャンネル名を表示し続ける。

## テスト（ADR-0001 / ADR-0002 準拠）

- `worker/src/misskey.test.ts`
  - `getTimeline({ kind: 'channel', id })` → `channels/timeline` へ `channelId`・`untilId`（cursor 指定時）で dispatch される
  - `kind: 'channel'` で `id` 無し → `MisskeyApiError(400)`
  - `listSources` → お気に入りが `📺 ${name}` ラベル・`kind: 'channel'` の SourceOption として並ぶ（リスト/アンテナと並列）
- `worker/src/index.test.ts`
  - `KINDS` 更新の回帰: `kind: 'channel'` + `id` 付き Source が `PUT /api/views` 検証を通過する／`id` 無しは拒否される
- `app/src/components/Deck.test.tsx`
  - カタログにチャンネル選択肢があるとき、ピッカーに `📺` プレフィックス付きラベルで描画される
  - チャンネル Source を選択して保存すると View の sources に `{ provider: 'misskey', kind: 'channel', id }` が入る
- CSS・視覚的な並びは ADR-0002 のテスト境界に従い視覚確認に留める

## 対象外（明示）

1. **チャンネルへの投稿（compose）** — `misskey-channel-display-spec.md` 対象外 1 と同じく別デザイン。
2. **発見系（`channels/featured` / `channels/search`）** — 候補集合はお気に入りのみ。発見は別機能。
3. **チップのディープリンク** — `misskey-channel-display-spec.md` 対象外 4（`channel.id` は確保済み）。
4. **チャンネル単位のフィルタ/ミュート**。
5. **お気に入り 100 件超のページング** — 必要になったら `listSources` 内で完結する変更。
6. **ピッカーのサブ見出しグループ化** — 候補数が増えた時点で再検討。

## ADR

不要。候補集合（お気に入り vs フォロー中）の決定は本当のトレードオフだが、変更は `listSources` 内に閉じて容易に可逆であり、保存済み View は channelId を参照するため候補集合の変更に影響されない。「変更不要」の条件を満たさず、根拠は本仕様に記録済みであるため ADR は作成しない。
