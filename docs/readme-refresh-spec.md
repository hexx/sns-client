# README を現状実装に合わせる 仕様（readme-refresh）

## 背景・目的
README は「MVP は Bluesky（閲覧＋投稿）」の頃の記述が残っているが、実装は Bluesky＋Misskey を統合済み（タイムライン・投稿・Like・Repost/Renote・Misskey 絵文字リアクション・カスタム絵文字解決・LinkCard・チャンネル・デッキ UI・デッキ Compose・PWA）。README を現状実装に一致させる。

README の役割は **製品紹介＋運用・開発セットアップガイド**（grill-with-docs セッションで確定）。

## 確定した方針
1. **冒頭（製品紹介）**: 「MVP は Bluesky」を撤廃し、複数 SNS（Bluesky＋Misskey）を1画面のデッキで統合閲覧・投稿する現在形の紹介文へ。単一 Cloudflare Worker が SPA 配信と BFF（`/api/*`）を兼務（同一オリジン）という説明は維持。
2. **docs リンク**: 冒頭は主要な少数（sns-client-spec / misskey-integration-spec / mixi2 決定）に絞り、全一覧は `docs/README.md`（新規索引）へ委ねる。
3. **マイルストーン撤廃→「機能」セクション**: 完了した計画履歴（M1〜M8）は README から除去し、現在形の機能リスト＋ **Provider × 機能マトリクス表**に置換。共通機能（デッキ・カスタム View・LinkCard・grapheme・PWA）は表の外に一文で添える。主要機能から対応仕様書へ個別リンク。
4. **「開発」セクション新規**: `npm test` / `npm run lint` / `npm run typecheck` を記載。テスト方針の詳細は ADR-0001 / 0002 へリンク。
5. **「構成」セクション修正**: `worker/` を「BFF（Bluesky: @atproto/api、Misskey: REST API へ dispatch）」に更新。欠落の `shared/`（共有の型と API 定数）と `scripts/`（アイコン生成）を追記。
6. **維持**: 前提 / セットアップ / デプロイ / Cloudflare Access / PWA メモは現状正確なため維持。

## Provider × 機能マトリクス（README 掲載内容）
| 機能 | Bluesky | Misskey |
|---|---|---|
| タイムライン閲覧・デッキ統合 | ○ | ○ |
| Compose（本文/CW/Media/リプライ/引用） | ○ | ○ |
| Like（単一カウンタ） | ○ | — |
| Repost / Renote | ○ | ○ |
| 絵文字リアクション（カスタム絵文字含む） | — | ○ |
| チャンネル表示 / チャンネル Source | — | ○ |

## 非対象
- ドメイン用語の変更なし（CONTEXT.md は変更しない）。
- ADR 不要（容易に撤回可能・自明・重大なトレードオフなし、のため）。
- コード変更なし（ドキュメントのみの変更）。
