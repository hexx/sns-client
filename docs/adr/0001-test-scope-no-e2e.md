# テスト範囲はユニット＋コンポーネントテストに限定し、E2E は採用しない

CI で検証するテストは、vitest によるユニットテストと Testing Library によるコンポーネントテストに限定する。ブラウザ E2E（Playwright 等）は意図的に採用しない。

E2E は本物の Bluesky アカウント（App Password）を CI に持たせる必要があり、さらに本番は Cloudflare Access（OTP ログイン）で保護されているため、自動化の費用対効果が著しく低い。一方、投稿のグラフェム計算や facets 生成、Compose/Timeline の挙動など、バグりやすく認証不要なロジックは jsdom 上のコンポーネントテストで十分に検証できる。

## Considered Options

- 品質ゲートのみ（typecheck / lint / build）— 却下：ロジックの回帰を検知できない
- ユニットテストのみ — 却下：React コンポーネントの挙動（投稿フロー、新着ピル等）を測れない
- **ユニット＋コンポーネントテスト（採用）**
- 上記＋E2E — 却下：認証の壁で ROI が低い

## Consequences

- 将来 E2E を足すなら、認証をモックした API レベルの E2E か、Cloudflare Access をバイパスできるステージング環境の整備が先決になる。
