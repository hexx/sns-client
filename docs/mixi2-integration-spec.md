# mixi2 統合 可行性とスコープ決定

> 複数 SNS を1画面で扱う PWA クライアント（[sns-client-spec.md](./sns-client-spec.md)）への
> **mixi2 対応の可否を確定した仕様**。結論: **現時点で Provider としては統合しない（型上のみ予約）**。
> 作成: grill-with-docs セッション（全6問合意）に基づく。
> 関連 ADR: [ADR-0009](./adr/0009-mixi2-out-of-scope.md)。用語は [CONTEXT.md](../CONTEXT.md) 参照。

---

## 1. 背景・問い

「mixi2 対応ってどこまでできるのか？」を確定する。本アプリの Provider（[CONTEXT.md](../CONTEXT.md)）は
「**利用者のタイムライン閲覧＋利用者本人名義の投稿**を統一モデルで扱う SNS 種別」を意味する。
Bluesky（App Password）／Misskey（API トークン）はいずれもこの形のユーザー API を持つ。

## 2. 結論

**mixi2 は現時点で Provider として成立しない。統合しない。**
`Provider` 型には `'mixi2'` を予約する（`mastodon` 予約と同型）が、実装・マイルストーンは置かない。

## 3. 事実根拠（mixi2 Developer Platform β、2026年時点調査）

mixi2 の公式 API は **Bot/Plugin アプリケーション用プラットフォーム**であり、ユーザー API ではない。

| 本アプリの Provider 要件 | mixi2 公式 API の現実 |
|---|---|
| 利用者のホーム TL 閲覧 | ❌ TL 取得 RPC が存在しない（Plugin 用 `GetCommunityTimeline` のみ＝Bot が導入されたコミュニティ限定） |
| 利用者本人名義の投稿 | ❌ 認証は OAuth2 **Client Credentials のみ**。アプリケーション作成＝Bot アカウント作成であり、投稿は常に Bot 名義。ユーザー委任フローが無い |
| 既存 BFF からの接続 | ❌ トランスポートは **gRPC**（grpc-web 非対応→ブラウザ直接不可。Cloudflare Workers は gRPC クライアント非対応→現 BFF 構成から呼べない） |
| 投稿機能 | ⭕ `CreatePost`（返信 `in_reply_to_post_id`／引用 `quoted_post_id`／メディア4枚／`PostMask`≒CW／配信制限≈プロフィール限定）／上限 **149文字** |
| リアクション | △ `AddStampToPost` は公式スタンプのみ・アプリ宛メンション投稿にのみ付与可・**取消不可** |
| イベント受信 | ⭕ Webhook / gRPC ストリームでアプリ宛メンション・DM を受信可能（TL の購読ではない） |

提供 RPC（Bot・Plugin 共通）: `CreatePost` / `DeletePost` / `SendChatMessage` / `InitiatePostMediaUpload` /
`GetPostMediaStatus` / `GetStamps` / `AddStampToPost` / `GetUsers` / `GetPosts`。
`GetPosts` は特定 ID のポスト取得のみ（アプリがアクセス可能なものに限る）。

## 4. 却下した代替案

### 4.1 非公式 API（公式アプリのプライベート API 流用）— 却下

技術的には社区クライアントが実例を持つが、採用しない:

- 利用規約違反リスク（アカウント停止＝単一アカウント運用の本アプリでは致命的）
- 無告知な仕様変更で壊れる保守性
- 認証機構がリバースエンジニアリング依存で、Cloudflare Access 前提の現運用と相性が悪い

### 4.2 Bot ブリッジ（Bot 名義で投稿のみ）— 将来拡張として記録するが設計しない

公式 API だけで今日動く唯一の道。しかし本アプリの `Post.author` は「その投稿の著者」であり、
自分の compose 結果が Bot 名義で描画されると **author 同一性が壊れる**（`repostedBy` とも異なる新概念）。
再審トリガー（§6）が揃えば Bot ブリッジは不要になるため、今設計投資しない。
将来必要になった場合、`author` 意味論の拡張から CONTEXT.md で再設計する。

## 5. 型予約の内容（実装）

- `shared/types.ts`: `Provider = 'bluesky' | 'misskey' | 'mastodon' | 'mixi2'`（型上予約のみ）
- Worker `KINDS.mixi2 = []`（Source 種別なし＝TL 取得不能の事実をコードで表現）
- Worker `isProvider` は mixi2 を**拒否**（runtime では bluesky/misskey のみ受理、mastodon 予約と同型）
- `/api/providers`（compose 能力カタログ）には**配信しない**（選択候補に混ざると誤解を招く）

## 6. 再審トリガー

mixi2 Developer Platform に以下 **2点が同時に**揃った時点で、Provider 化を再審する:

1. **ユーザー委任 OAuth**（Authorization Code フロー等＝利用者本人名義で操作できる認証）
2. **ホームタイムライン取得 API**（フォロー中 TL を引ける RPC/REST）

gRPC トランスポート制約（Cloudflare Workers から呼べない）はトリガーに含めない。
再審時に BFF 構成（Workers 外への分離等）の投資判断として別途扱う。

## 7. 前提・リスク

- ⚠️ mixi2 API は β。提供機能・制限（149文字等）は変動し得る（再審時に再調査する）。
- ℹ️ 本決定は「永久に不支持」ではなく「成立条件が未達」の記録である。
