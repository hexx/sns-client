# SNS Client

複数 SNS を1画面で扱うクライアントのドメイン。個々の SNS（Bluesky 等）の差異を吸収し、統一されたモデルで投稿を扱う。MVP の対象は Bluesky。

## Language

**Post**:
SNS 横断で統一された「1つの投稿」のドメインモデル。UI は各 SNS の生データではなくこのモデルだけを扱う。
_Avoid_: status, toot, record

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
1つの Provider に属する、投稿の時系列ストリーム1つ。home（ホーム）や、Bluesky の feed、Misskey の antenna などの種別（kind）と、必要に応じて ID を持つ。Timeline は1つ以上の Source を合成して作られる。
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

**Timeline**:
1つの View に属し、その View を構成する Source 群の投稿を時系列に合成して描画した一覧。無限スクロールで継ぎ足し、新着は自動挿入せずピルで知らせる。
_Avoid_: feed, home, list, view

**grapheme**:
投稿長の计数単位。文字数（コードポイント）ではなくグラフェムで数え、絵文字や結合文字を1単位とする。
_Avoid_: character, 文字数, length

**CW（content warning）**:
投稿に付けるコンテンツ警告。閲覧前に内容を伏せる。
_Avoid_: spoiler, NSFW

**reply**:
既存の投稿への返信。スレッド上の位置を `root` と `parent` で表す（MVP はトップレベル投稿への返信のみ）。
_Avoid_: comment, thread

**quote**:
既存の投稿を参照して自分の投稿に埋め込むこと（引用）。
_Avoid_: repost, share, retweet

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
