# 全依存ライブラリの最新化（2026-07）

## 目的・背景

Renovate により minor/patch は自動マージされているが、major 更新は手付かずで 13 件滞留している。
MVP 段階でコード量が少ない今が一括解消の最低コスト地点であり、あわせて再発防止の仕組みを入れる。

## スコープ（全 13 件・例外なし）

| パッケージ | 現在 | 目標 |
|---|---|---|
| typescript | 5.9 | 7 |
| jsdom | 26 | 29 |
| @testing-library/jest-dom | 6 | 7 |
| vite | 6 | 8 |
| @vitejs/plugin-react | 4 | 6 |
| vitest | 3 | 4 |
| react / react-dom | 18 | 19 |
| @types/react / @types/react-dom | 18 | 19 |
| wrangler | 3 | 4 |
| @cloudflare/workers-types | 4 | 5 |
| @atproto/api | 0.13 | 0.20（caret `^0.20.0` 維持） |

## 実行計画（5 PR を依存順にマージ）

| # | グループ | パッケージ | 備考 |
|---|---|---|---|
| 1 | toolchain | typescript, jsdom, @testing-library/jest-dom | CI のみで検証 |
| 2 | vite/vitest | vite 8, @vitejs/plugin-react 6, vitest 4 | plugin-react 6 は vite 8 必須（同時上げ）。vite-plugin-pwa 1.3.0 は据置（既に vite 8 対応） |
| 3 | react | react(-dom) 19, @types/react(-dom) 19 | @testing-library/react 16.3.2 は据置（react 19 対応済） |
| 4 | workers | wrangler 4, @cloudflare/workers-types 5 | wrangler 4 が workers-types ^5 を要求するため同時上げ必須 |
| 5 | atproto | @atproto/api ^0.20.0 | 0.x のため単独 PR で差分を集中確認 |

## 検証ゲート

- **全グループ**: CI（lint / typecheck / test / build）グリーンを必須とする。
- **グループ 2〜5**: 加えて手動スモークを必須とする。
  - `npm run dev:app` + `npm run dev:worker` で起動 → タイムライン表示 → 1 件投稿
  - グループ 4: `wrangler deploy` による preview/staging へのデプロイ確認
  - グループ 5: 実 Bluesky API への通信確認

## フォールバック方針

最新版が互換性・動作上の問題を起こした場合、作業を停止せず、
**問題なく動く最新バージョン（最新互換版）に後退し、PR 本文に後退理由を明記**して次へ進む。
後退した分は後述の月次 major PR で再挑戦されるため、永続的な取り残しにはしない。

## 再発防止（最終 PR で renovate.json に反映）

major 更新を月次で 1 本にグループ化する packageRule を追加する。

```json
{
  "matchUpdateTypes": ["major"],
  "groupName": "dependencies (major)",
  "schedule": ["monthly"]
}
```

これにより major 更新が個別 PR として滞留せず、月 1 本必ず目を通す運用になる。

## ドキュメント方針

- **ADR**: 作成しない。本仕様の決定はいずれも容易に撤回可能で、ADR 基準（撤回困難・文脈なしでは驚き・実在する trade-off）を満たさない。
- **CONTEXT.md**: 変更なし。本仕様の決定は全て工学的関心であり、ドメイン用語表の対象外。
