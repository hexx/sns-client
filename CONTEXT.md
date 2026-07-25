# SNS Client

複数 SNS を1画面で扱うクライアントのドメイン。個々の SNS（Bluesky 等）の差異を吸収し、統一されたモデルで投稿を扱う。MVP の対象は Bluesky。

## Language

**Post**:
SNS 横断で統一された「1つの投稿」のドメインモデル。UI は各 SNS の生データではなくこのモデルだけを扱う。
_Avoid_: status, toot, record

**Provider**:
投稿の由来となる SNS の種別（`bluesky` / `mastodon`）。
_Avoid_: source, network, service

**Media**:
投稿に添付された画像。表示用の URL と alt（説明）を持つ。
_Avoid_: attachment, blob, asset

**Timeline**:
時系列に並んだ投稿一覧。無限スクロールで継ぎ足し、新着は自動挿入せずピルで知らせる。
_Avoid_: feed, home, list

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

**LinkCard**:
投稿に添付された外部リンクのプレビューカード。URL・タイトル・説明・サムネイル画像を持つ。`Media`（画像添付）とは別概念。
_Avoid_: Twitter card, OGP card, external embed, preview
