# アプリアイコン：SVG 単一ソース + コミット済み PNG、Provider ブランドカラーの不採用

アプリアイコンを `scripts/gen-icons.mjs` のビルド時生成（プレースホルダの青丸）から、**`app/public/icon.svg` を唯一のソースとし、ラスター PNG をコミットする静的アセット**へ切り替える。動機は2つ：① 生成スクリプトが `npm run build` のたびに `app/public/icon-*.png` を上書きし、正式アイコンを置いても壊れる罠になっていたこと、② アイコンの図柄を「合流する3ストリーム（複数 Source → 1 Timeline）」と定めた結果、コード生成より SVG の方が表現力・保守性で勝ること。併せて、3本線の色は **Provider ブランドカラーではなく製品アクセント `#1d9bf0` の明度ランプ**とする。仕様: [docs/app-icon-spec.md](../app-icon-spec.md)

## Considered Options

- **ビルド時にラスター化する**（sharp 等を build に組み込む）— 却下：年に数回しか変わらないアイコンのために、全ビルド・デプロイへ重いネイティブ依存を課すのは不釣り合い。
- **生成スクリプトを維持して図柄だけ改良する** — 却下：ビルド時上書きの罠という構造問題が残る。
- **3本線を Provider ブランドカラーで色分けする**（Bluesky 青 / Misskey 緑 / Mastodon 紫など）— 却下：Mastodon と Misskey は同じ ActivityPub ファミリであり線とブランドが1対1に対応しない。mixi2（サポート予定）にはブランドロゴ使用ガイドラインがあり、サードパーティのブランド色流用は原理的に避けたい。Provider 数が増えるたびにアイコンが陳腐化する。線は「一般的な N 本の Source」を表し、色は製品自身のアクセントに紐づける。

## Consequences

- PNG はコミット済み成果物となる。`icon.svg` を変えた場合は `scripts/render-icons.mjs`（sharp・devDependency）を手動実行して再生成・コミットする。
- `npm run build` はアイコン生成を行わなくなり、`scripts/gen-icons.mjs` は削除される。
- 将来「Provider ごとに色分けしよう」という提案が出た場合、この ADR の棄却理由（ファミリ重複・商標ガイドライン・Provider 可変）を先に確認すること。
