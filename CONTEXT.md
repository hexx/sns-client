# SNS Client

複数 SNS を1画面で扱うクライアントのドメイン。個々の SNS（Bluesky 等）の差異を吸収し、統一されたモデルで投稿を扱う。MVP の対象は Bluesky。

## Language

**Post**:
SNS 横断で統一された「1つの投稿」のドメインモデル。UI は各 SNS の生データではなくこのモデルだけを扱う。
_Avoid_: status, toot, record

**Author**:
Post を著した主体の、SNS 横断統一モデル。Provider 内で安定した opaque な識別子（`id`。Bluesky の DID、Misskey のユーザー ID、Nostr の pubkey 等）と、変わりうる表示名（`handle` / `displayName`）を持つ。block / mute の対象はこの `id` で特定される。
_Avoid_: user, account, actor

**block（ブロック）**:
ある Author との相互作用（リプライ・reaction・repost 等）を Provider 側で遮断する操作。相手の投稿も自分から見えなくなる。安全のための硬い操作で、Provider 本体の状態として成立する（クライアント側のフィルタではない）。
_Avoid_: 拒否, reject

**mute（ミュート）**:
ある Author の投稿・再共有を、自分から見えなくする Provider 側の操作。相手には分からず、相互作用は遮断しない。block より柔らかく、主にタイムラインのノイズ低減のためのもの。
_Avoid_: 非表示, hide, ignore

**Provider**:
投稿の由来となる SNS の種別（`bluesky` / `misskey` / `mastodon` / `mixi2` / `nostr`）。`mastodon`・`mixi2` は型上予約のみ（mixi2 は公式 API が Bot 用のため Provider 不成立、docs/mixi2-integration-spec.md）。Threads は Misskey の ActivityPub 連合で吸収するため Provider 不成立（docs/threads-integration-spec.md、ADR-0011）。型予約もしない。`nostr` は初の読み取り専用 Provider（閲覧のみで Destination を持たない、docs/nostr-integration-spec.md、ADR-0013）。
_Avoid_: network, service

**remote user（リモートユーザー）**:
Source が属するインスタンスの外にいる、連合経由で現れるユーザー。投稿者表示が `username@host` になる主体。Threads ユーザーは Misskey の Source において `@user@threads.net` のリモートユーザーとして現れる。
_Avoid_: external user, federated user, よそのユーザー

**relay（リレー）**:
Nostr における、イベント（投稿）を預かって配信する WebSocket サーバ。中央サーバが存在しないため、閲覧は「複数リレーへの並列照会」として行う。Source の実現形態としての `relay` Source は、そのリレーのグローバル新着（コミュニティのローカル TL 相当）を意味する。
_Avoid_: server, instance, node

**pubkey（公開鍵）**:
Nostr におけるユーザー識別子。`npub1...` は同じ公開鍵の人間可読な bech32 表現。Nostr にはサーバ側のタイムラインが無いため、Source の実現形態としての `pubkey` Source は、この公開鍵が署名したイベントの購読を意味する。
_Avoid_: user ID, account, address

**Source**:
1つの Provider に属する、投稿または通知の時系列ストリーム1つ。home（ホーム）や、Bluesky の feed、Misskey の antenna などの種別（kind）と、必要に応じて ID を持つ。Timeline は1つ以上の Source を合成して作られる。通知（kind: `notifications`）も Source の一実現形態だが、Post ストリームとは合成できない（通知同士の合成のみ許可。docs/notifications-spec.md §2）。
_Avoid_: feed, antenna, list, channel（これらは特定の Provider における Source の実現形態であり、総称ではない）

**Destination**:
新しい Post の提出先（書き込み側）。`Source` と対になる概念で、`{provider, kind, id?}` と同じ形状を持つが、kind は投稿可能な種別（`home` / `channel`）に限られる（`list` / `antenna` / bsky `feed` は閲覧専用のため Destination にならない）。Compose は1つの投稿につき正確に1つの Destination を選ぶ。
_Avoid_: target, 投稿先（識別子として）, to

**View**:
利用者が閲覧する1つの画面の定義。1つ以上の Source の集合で表され、クライアントがこの定義に従って各 Source を fetch・時系列合成し、Timeline として描画する。統合ホームも「フィード＋アンテナ」も等しく View の一实例。
_Avoid_: column, tab, feed, timeline（Timeline は描画結果、View はそのソース構成の定義）

**Channel**:
投稿が所属する Misskey チャンネル（ノートが投下されるコミュニティ）。Post は `{id, name}` を保持し、UI は名前を表示して通常投稿と見分ける。Source の実現形態としての channel（チャンネルタイムラインというストリーム）とは別概念。
_Avoid_: group, community, circle

**Media**:
投稿に添付された画像。表示用の URL と alt（説明）を持つ。
_Avoid_: attachment, blob, asset

**Lightbox（ライトボックス）**:
投稿に添付された Media を拡大して見せる重ね合わせ表示。投稿内の画像を選択すると開き、背景を暗くして、画面に収まる最大サイズで1枚ずつ表示し、同じ投稿内の複数画像を切り替えられる。識別子・正式名が Lightbox で、日本語の「拡大表示」は説明語。
_Avoid_: MediaViewer, ImageViewer, gallery, modal

**Timeline**:
1つの View に属し、その View を構成する Source 群の投稿を時系列に合成して描画した一覧。無限スクロールで継ぎ足し、新着は自動挿入せずピルで知らせる。
_Avoid_: feed, home, list, view

**Thread（スレッド）**:
1つのフォーカス投稿を軸に、その祖先（root までの親連鎖）と子孫（リプライ群）を合わせて表す会話の広がり。オーバーレイで表示する閲覧単位で、Timeline（複数 Source の時系列合成）とは別概念。日本語の「スレッド表示」「会話表示」は説明語。
_Avoid_: conversation, 会話, detail view, post detail

**unread（未読）**:
タイムラインに挿入された投稿のうち、利用者がまだ到達していないもの。新着の発見（ポーリング・手動更新）で挿入された投稿が対象で、追加読み込み（過去遡及）は含まない。区切り線（「新着はここまで」）をスクロールで通過した瞬間（可視領域の上部から完全に外れた瞬間）にすべて既読になる。新しい取り込みで1件以上の新着が挿入されると、既存の未読は差し替えられる（取り込みは利用者の明示的操作に限られるため、最新回の取り込みが新着ラインを更新する。自動挿入を導入した場合は再検討）。セッション内のみで保持され、永続化しない。UI 文言としては「未読」を使わず、既存の語「新着」に統一する（docs/unread-divider-spec.md）。タイムラインのこの概念と、通知の既読状態（Notification の `isRead`・バッジ。docs/notifications-spec.md §5）は別概念である。
_Avoid_: read state, 既読フラグ, unread（UI 文言として）

**grapheme**:
投稿長の计数単位。文字数（コードポイント）ではなくグラフェムで数え、絵文字や結合文字を1単位とする。
_Avoid_: character, 文字数, length

**Notification（通知）**:
ある Author の行動（mention・reply・quote・like/reaction・repost/renote・follow 等）を、自分宛に知らせる1件の出来事。統一モデルは `{id, provider, type, createdAt, isRead, actor?, post?, text?}` で、Post とは別概念。UI は3分類（投稿を伴う / actor のみ / テキストのみ）を type でなくフィールドの有無で判定する。タイムラインの「新着（unread）」とは別概念で、既読は「View に表示された瞬間に全既読」される（docs/notifications-spec.md）。
_Avoid_: activity, event, お知らせ（announcement はサーバー告知で別概念）, notification item

**CW（content warning）**:
投稿に付けるコンテンツ警告。閲覧前に内容を伏せる。
_Avoid_: spoiler, NSFW

**reply**:
既存の投稿（親）への返信として位置づけられた Post。返信対象は opaque な参照（`ref` のエコー）で指し、プロバイダ固有の位置解釈（bsky の root/parent 等）は解決側（BFF、または nostr のブラウザ直接解決）に閉じ込める。祖先・子孫の広がりを表示する単位は reply ではなく Thread。
_Avoid_: comment, thread（thread は返信そのものでなく会話の広がり）

**quote**:
既存の投稿を参照して自分の投稿に埋め込むこと（引用）。
_Avoid_: repost, share, retweet

**quote card（引用カード）**:
投稿に埋め込まれた quote を表示するインラインカード。1階層のみで、カード自体は表示専用（返信・リアクション等の操作は不可）。通常表示（本文5行截断＋先頭サムネ）と、展開表示（全文＋全 Media＋stats＋日時＋外部リンク）の2状態を持つ。カード本体のクリックは引用先の Thread へ遷移する（「もっと見る」展開トグルと外部リンクは別の操作として維持）。引用先が取得不能（削除・ブロック等）だった場合はカードの代わりに取得不能の案内行になり、遷移先は無い。
_Avoid_: embed card, preview, quote view

**Compose**:
新しい Post を作成する行為、およびそのための UI（投稿モーダル）。reply・quote を伴う場合もある。投稿先 Provider の選択、本文、Media、CW を1つの下書きとして扱う。日本語の「新規投稿」は説明語であり、識別子としての正式名は Compose。
_Avoid_: post（動詞として）, new post, 投稿作成, write

**repost**:
既存の投稿を、本文を添えずに自分のフォロワーへ再共有すること。Misskey の renote、Bluesky の repost を指す統一用語。モデルでは「誰が再共有したか」を `repostedBy` で表す。本文を添えて再共有すれば quote（引用）であり別概念。
_Avoid_: renote, boost, retweet, share

**reaction**:
投稿への絵文字による反応。Misskey は複数種の絵文字反応（カスタム絵文字を含む）を持ち、モデルでは `{emoji, count}` の任意リストで保持する。カスタム絵文字の reaction は解決済みの画像 URL を伴う。Bluesky の「いいね（like）」は単一カウンタのため、総数として `likes` に集約し reaction リストは持たせない。Misskey では1ユーザーの反応は1投稿につき常に1つ（`me` は高々1つの絵文字に付く）。同じ絵文字を再度選ぶと解除、異なる絵文字を選ぶと置換になる。
_Avoid_: favorite, いいね, like（like は Bluesky における reaction の単一カウンタ実現）

**custom emoji（カスタム絵文字）**:
Provider インスタンスが提供する、画像として描画される絵文字。Unicode 絵文字（テキスト描画）と対になる概念。各 Provider に属する名前（`:name:` 形式）で参照され、描画にはインスタンス固有の画像 URL へ解決する必要がある。本文・reaction の両方に現れる。
_Avoid_: sticker, image emoji

**LinkCard**:
投稿に添付された外部リンクのプレビューカード。URL・タイトル・説明・サムネイル画像を持つ。`Media`（画像添付）とは別概念。
_Avoid_: Twitter card, OGP card, external embed, preview
