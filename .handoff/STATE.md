# Grill セッション状態: スレッド／会話表示（thread view）

タスク: ユーザーの「このアプリをどこか改善したいなあ」を受け、改善テーマを**スレッド／会話表示**と定め、その仕様を /grill-with-docs スキル（/grilling + /domain-modeling）でまとめる。

## ⚠️ 最重要: 前セッションの失敗と教訓（次の AI は必ず読むこと）
- 前 AI は Q1 承認の後、**Q2〜Q9 を「自分の推奨＝確定」とみなして先走り**、仕様書・ADR・用語集まで書き上げた。これは時期尚早。
- ユーザーは明確に否定: 「『あなたの推奨どおりで良いです』とは言いましたが、残りの質問全部が推奨どおりで良いと言ったわけではありません。**Q2からもう一度**お願いします。」
- つまり **「あなたの推奨どおりで良いです」はそのとき問うていた1問のみに有効**。残りの質問すべてへの白紙委任ではない。必ず1問ずつ質問し、回答を待て。複数問を一度に聞くな。合意前に実装するな。
- 前 AI は compaction の自動継続通知のループに巻き込まれ、「待機」と「実装」を往復して空回りした。次の AI は**Q2 を提示して回答を待つだけ**にすること。自動通知を実装のゴーサインと解釈しない。

## 確定事実（コードベース確認済み。再確認してもよい）
- プロジェクト: SNS クライアント（Bluesky + Misskey + Nostr 読み取り専用）、React+Vite SPA + Cloudflare Worker BFF（Hono）、PWA
- **アプリにルーター無し**。ナビゲーション = デッキカラム + モバイル pager + モーダル（Compose/View 編集）+ Lightbox オーバーレイのみ
- `PostCard` の `<article>` に onClick は無い（詳細画面への入口が一切ない）
- `Post` は `ref`（opaque なプロバイダ自己参照）と `url`（permalink）を持つ。wire には `replyTo`（`ref` のエコー）
- **用語集とコードの矛盾（要対応）**: CONTEXT.md の reply 項は「root と parent で表す」と書いていたが、コードの `Post` に root/parent フィールドは無い（wire の `replyTo` のみ。bsky 書き込み側がトップレベル返信で `reply.root=reply.parent=ref` を設定）
- **ADR-0015**「引用カードはインライン展開＋外部リンクとし、アプリ内スレッドビューは持たない」はスレッドビューを禁止しない。将来の新設を想定済みで、「スレッドビューができたら quote card のクリック挙動を再審する」という宿題を残す
- Bluesky `getPostThread({ uri, depth, parentHeight })` — 引数は @atproto/api 型定義で確認済み
- Misskey: `notes/show` / `notes/conversation`（祖先）/ `notes/children`（子孫、replyId 付き平坦リスト、until ページング）— `mkApi` 経由の REST 直接呼び出し
- ADR-0014: nostr はブラウザ直接 WebSocket・読み取り専用。ADR-0010: モバイルは全 View マウントのスワイプ paging。テスト範囲は ADR-0001/0002
- スキル: /home/pi/.pi/agent/skills/grill-with-docs/SKILL.md（/grilling を実行し /domain-modeling を使う）
  - grilling: 1問ずつ質問・必ず推奨を添える・事実はコードベースで調べる・合意前に実装しない
  - domain-modeling: 確定した用語は CONTEXT.md にその場で反映。ADR は3条件（覆しにくい／文脈なしでは意外／本物のトレードオフ）を満たすときのみ

## 確定済み決定（ユーザー承認済み）
- **Q1（改善の方向性）= スレッド／会話表示** — 承認済み
- **Q2（ナビゲーション）= A オーバーレイ**（ルーター導入せず。Lightbox/Compose と同一パターン）— 承認済み。TanStack Router は技術的に導入可能だが、スレッドのためだけに入れるのは割に合わないと説明し、ユーザー了承。
- **Q3（スコープと名前）= A**（祖先＋フォーカス投稿＋子孫1ページ。概念名 Thread）— 承認済み
- **Q4（データ取得）= A**（`GET /api/thread` 新設、BFF がプロバイダ差を吸収）— 承認済み
- **Q5（描画形状）= A**（BFF が DFS 順＋depth に平坦化、Post に親子フィールドは足さない、インデント depth 5 頭打ち）— 承認済み
- **Q6（スレッド内操作）= A**（reply/like/repost/reaction を再利用、reply 成功後はスレッド再取得）— 承認済み
- **Q7（入口）= A**（カード本文クリック。Media/リンク/ボタン/quote card は貫通しない。返信数 stats でも開く。nostr は入口なし）— 承認済み
- **Q8（取得不能ノード）= A**（`ThreadNode.unavailable` プレースホルダ行）— 承認済み
- **Q9（Nostr）= B**（MVP に含める。推奨 A を覆す）— 承認済み。これに伴い Q7 を修正（nostr にも入口を付ける）
- **Q10（Nostr 解決方法）= A**（ブラウザ直接 queryRelays で解決し、同じ ThreadResponse 形状に合流。子孫は `#e` 照会、祖先は NIP-10 の e タグ遡上）— 承認済み
- **Q11（Nostr 取得範囲）= A**（祖先25段・子孫1バッチ（limit 30 程度）・欠落は unavailable・kind:0 プロフィール再利用）— 承認済み
- **Q12（quote card のクリック挙動）= B**（quote card クリックで引用先のスレッドを開く。推奨 A を覆す。ADR-0015 の宿題は「変更あり」で決着）— 承認済み
- **Q13（quote card の操作整理）= A**（カード本体クリックで引用先スレッド。「もっと見る」トグルと ↗ 外部リンクは貫通しない。quoteUnavailable は入口なし。bsky/misskey のみ）— 承認済み
- **Q14（スレッド内の投稿クリック）= A**（同一オーバーレイ内でフォーカスを置換して引き直し。スタックしない）— 承認済み
- 補足（事実、ADR-0014 由来）: nostr は読み取り専用のため、スレッド内操作（Q6）は nostr 投稿には適用せず閲覧のみ。

## 未確定（Q2 からやり直し中。以下は前 AI の「推奨」であり未承認）
- ~~Q2 ナビゲーション~~ → 確定（A オーバーレイ）
- ~~Q3 スコープと名前~~ → 確定（祖先＋フォーカス＋子孫1ページ、Thread）
- ~~Q4 データ取得~~ → 確定（GET /api/thread 新設、BFF 吸収）
- ~~Q5 描画形状~~ → 確定（BFF が DFS 平坦化、Post 変更なし、depth 5 頭打ち）
- ~~Q6 スレッド内操作~~ → 確定（既存操作を再利用、reply 後は再取得）
- ~~Q7 入口~~ → 確定（本文クリック、貫通なし、nostr 入口なし）
- ~~Q8 取得不能ノード~~ → 確定（ThreadNode.unavailable プレースホルダ）
- ~~Q9 Nostr~~ → 確定（B: MVP に含める）
- Q10 Nostr 解決方法 → 確定（ブラウザ直接解決、ThreadResponse に合流）

## 前 AI が作成した「仮ドラフト」（未承認の推奨を記載。決定確定後に書き直すこと）
- `docs/thread-view-spec.md`（新規・全編が推奨ベース）
- `docs/adr/0017-thread-bff-flattened-depth.md`（新規 ADR）
- `CONTEXT.md`（Thread 項追加・reply 項 sharpen — どちらも推奨ベース）
- `docs/README.md`（索引に上記追加＋欠落 ADR 0013〜0016 を補填。補填部分は事実なので残してよい）
- 扱い: 消さず、ユーザーの確定決定に合わせて該当箇所を上書きする。決定と食い違う推奨が残らないよう最終的に整合させる。

## 検証状態
- テスト 368/368 passed / lint (oxlint --deny-warnings) clean / typecheck (worker+app) clean
- git 差分 = 上記ドキュメント4点のみ（コード・テストは一切未変更）

## 現在の進行
- Q1〜Q14 すべて確定（Q9・Q12 は B で推奨覆し）。共通理解の最終確認も承諾済み。
- **ドキュメント確定版 整備済み**: thread-view-spec.md 全面書き直し／CONTEXT.md（quote card・reply 項）／ADR-0015 再審決着追記／ADR-0017 nostr 注記／quote-display-spec.md §非対象・README 索引を整合。グリリングセッション完了。
- **実装済み（ユーザー指示）**: shared/types.ts（ThreadResponse/ThreadNode）・constants（/api/thread）・worker bsky/misskey の getThread＋index ルート・shared/nostr の getThread（BFS 子孫拡張＋NIP-10 祖先遡上）・app api/lib/thread・ThreadView.tsx・PostCard 入口＋quote card 遷移・TimelineCore/Deck/MobilePager/App 配線・styles。検証: 417/417 tests / lint clean / typecheck clean / build ok。

## ユーザーとのやり取りの制約（厳守）
- ユーザーへの回答・質問はすべて日本語（AGENTS.md）
- すべての返答は「ファイルに書く → 日本語を確認する → ファイルを読み込む → 読み込んだ内容を**そのまま**返す」手順。言い換え・書き直し・翻訳（とくに英語化）は禁止。前セッションはこのドリフトで叱責された。
