# Threads 統合の可否と連合経由閲覧の仕様

> 複数 SNS を1画面で扱う PWA クライアント（[sns-client-spec.md](./sns-client-spec.md)）への
> **Threads 対応の可否を確定した仕様**。結論: **`threads` Provider は実装しない。Threads ユーザーの投稿閲覧は Misskey の ActivityPub 連合経由で賄う（コード変更ゼロ・保証なしの文書化された振る舞い）**。
> 作成: grill-with-docs セッション（全4問合意）に基づく。
> 関連 ADR: [ADR-0011](./adr/0011-threads-via-misskey-federation.md)。用語は [CONTEXT.md](../CONTEXT.md) 参照。

---

## 1. 背景・問い

「Threads 対応ってどこまでできるのか？ActivityPub があるから Misskey だけでも何とかなるのか？」を確定する。

欲求の中身は grilling により **「Threads ユーザーの投稿を、Bluesky / Misskey と同じ統合タイムラインで読みたい」（閲覧）** と確定した。自分の Threads アカウント名義での投稿（書き込み）は本セッションのスコープ外。

## 2. 結論

1. **閲覧は Misskey 連合経由で賄う。** Threads 投稿は Misskey ホーム Source 内にリモートノートとして到着し、既存の Misskey プロバイダが投稿者を `@user@threads.net` 形式で描画する（`worker/src/misskey.ts` のリモートユーザー handle 組み立てによる既存挙動）。**新規コード・UI 変更はゼロ。**
2. **`threads` Provider は実装しない。`Provider` 型への予約もしない。** mastodon・mixi2 の型予約と異なり「将来対応予定」ではなく「不要と判断」のため。
3. **位置づけは「文書化された振る舞い（保証なし）」。** アプリのコード責務はゼロ。実現は外部インスタンス間（misskey.io ↔ threads.net）の連合状態に依存する。

## 3. 事実根拠

### 3.1 ActivityPub 連合でできること（Misskey 経由）

Threads はアカウント単位で連合を opt-in したユーザーの投稿を ActivityPub で配信する（2024年3月〜）。

| 行為 | 方向 | 成否 | 備考 |
|---|---|---|---|
| Threads ユーザーの投稿閲覧 | Misskey→Threads | ⭕ | 相手を Misskey 側でフォローすればホームに流れる。到着に数分の遅延あり |
| reply | Misskey→Threads | ⭕ | Threads 側に返信として届く |
| reaction | Misskey→Threads | ⭕ | Misskey の絵文字反応は `Like` として届く（絵文字種別は伝わらない） |
| renote（再共有） | Misskey→Threads | ⭕ | `Announce` として届く |
| quote（引用） | 双方向 | ⭕ | Threads は `_misskey_quote` と FEP-e232 を実装済み。Misskey の引用は Threads で表示され、逆も表示される |
| Threads ユーザーが Misskey の投稿を閲覧 | Threads→Misskey | ⭕ | Threads 側で連合共有 opt-in が必要。Following タブ上部の**専用 Fediverse フィード**に表示され、通常投稿とは混ざらない。Threads 内検索で Misskey ユーザーを発見・フォロー可能（2025年6月〜） |
| DM・フォロワー限定投稿の配送 | 双方向 | ❌ | Threads は処理しない |

**制約**:

- 連合を opt-in していない Threads ユーザー（多数派）の投稿は**一切見えない**。
- Threads 側の通知・「自分の Threads フィード」は Misskey 経由では取得できない。
- misskey.io ↔ threads.net 間の連合品質にはムラがある。2024年12月時点の社区報告では、misskey.io からの threads.net ユーザーの直接フォローが完了しない・URL 照会が 4xx、一方リノート経由で流れてきた Threads 投稿の閲覧は可、というグラデーションが確認されている。インスタンス設定と時期に依存するため、受け入れ確認（§5）で都度検証する。

### 3.2 Threads API（Meta 公式）の読み取り側能力

直接 Provider を実装する場合の対抗軸として調査した（graph.threads.net、2026年時点）。

| 本アプリの閲覧要件 | Threads API の現実 |
|---|---|
| 他人（非連合ユーザー含む）のタイムライン購読 | ❌ **API が存在しない**（`/me/threads` は自分の投稿のみ） |
| 公開投稿のキーワード検索 | △ `threads_keyword_search` 権限の**アプリレビュー必須**（Tech Provider 認証〜1週＋権限ごとに2〜4週）。未承認時は自分の投稿のみ検索可 |
| 個別の公開投稿の表示 | ⭕ oEmbed（トークン不要） |
| 書き込み側（参考・スコープ外） | ⭕ 投稿（テキスト/画像/動画/カルーセル/投票）・reply・quote・repost・topic タグ。❌ いいね API なし・フォロー管理なし・DM なし。OAuth は Meta 開発者アプリ登録＋60日トークンの更新管理が要る |

## 4. 却下・対象外とした案

### 4.1 非連合 Threads ユーザーの継続購読（c1）— 対象外

連合は相手の opt-in が必須、Threads API には他人のタイムライン API が存在しない。**公式手段で不可能。** 残るは非公式スクレイピングのみで、mixi2 を対象外にした [ADR-0009](./adr/0009-mixi2-out-of-scope.md) と同型の理屈（ToS 違反リスク・無告知変更への脆さ）により採用しない。

### 4.2 公開投稿のスポット検索（c2）— 対象外

公式手段（§3.2 の検索＋oEmbed）は存在するが、Meta 開発者アプリ登録・Tech Provider 認証・アプリレビュー・Worker での OAuth トークン更新管理という固定費がかかる。「たまに覗く」用途にはブラウザで threads.net を開けば足り、費用対効果が成立しない。

### 4.3 `threads` Provider の新規実装（書き込み含む）— 対象外

本セッションで確定した欲求は閲覧のみであり、連合で充足する。自分の Threads 名義での投稿が必要になった場合は再審トリガー（§6）により再設計する。

## 5. 受け入れ確認手順（手動・保証なし）

アプリのコードではなく外部の連合状態を検証する手順。仕様変更時や「見えなくなった」報告時に実施する。

1. misskey.io で「照会」に `https://www.threads.net/@{ユーザー名}` を入力し、連合 opt-in 済みの Threads ユーザーのプロフィールが表示されることを確認する。
2. そのユーザーをフォローする（直接フォローが完了しない場合は、別の連合クライアント経由でフォローするか、リノート経由の閲覧に退避する）。
3. 本アプリの Misskey ホーム Source を開き、そのユーザーの投稿が `@{ユーザー名}@threads.net` の投稿者表示でタイムラインに流れてくることを確認する。
4. その投稿への reaction・reply が Misskey 上で通常通り実行できることを確認する（Threads 側への到達は Threads 上の表示で任意確認）。

## 6. 再審トリガー

以下いずれかが成立したら本決定を再審する:

- 自分の Threads アカウント名義で投稿・reply したい欲求が確定した（書き込みは連合では原理不可）。
- Threads API が他人のタイムライン購読、またはレビュー不要の公開フィード取得を公式に開放した。
- misskey.io ↔ threads.net の連合品質が§5 の受け入れ確認を恒常的に通らないほど劣化した（利用インスタンスの変更、または直接 Provider の再検討）。
