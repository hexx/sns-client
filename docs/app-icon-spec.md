# アプリアイコン（ファビコン / PWA アイコン）仕様

「サイトのアイコンがない」問題の解消と、正式アイコンの定義。現状は ① `index.html` に `<link rel="icon">` が無く**ブラウザタブが空白**になり、② ホーム画面用アイコンが `scripts/gen-icons.mjs` 生成のプレースホルダ（青背景＋白い丸）で、**ビルドのたびに `app/public/icon-*.png` を上書きする**という構造的な罠がある。本仕様は両方を同時に直す。

関連する決定の経緯: [ADR-0008](./adr/0008-app-icon-static-svg-assets.md)

## コンセプト

**合流する3本のストリーム。** 3本の線が左から現れ、中央で束ねられて1本になり、右へ流れる。

これは `CONTEXT.md` のドメインそのものの視覚化である：

- 3本の線 = **Source**（投稿の時系列ストリーム。home / feed / antenna など）
- 束ねられた1本 = **Timeline**（View を構成する Source 群を時系列合成した結果）

線は**特定の Provider を表さない**。「一般的な N 本の Source」の象徴であり、本数と実 Provider 数は一致させる必要がない（MVP は Bluesky 単体でもアイコンは不変）。

## デザイン

### 図形

- 3本のストロークが合流して1本になる。終端に矢印は付けない（「流れ」で十分、16px でのノイズを避ける）
- **16px（タブ）で「複数 → 1本」が読めること**を最優先に、ストロークは太め・合流角度は緩やかにする
- 詳細なジオメトリ（太さ・曲率・余白）は実装時に調整する。判断基準は小サイズでの可読性

### セーフゾーンとタイル

- **maskable セーフゾーン**: グリフはキャンバス中央 80% 以内に収める。これにより `icon-512.png` を `any` と `maskable` で兼用できる
- **SVG ファビコン**: 背景は `#0b0f14` の**丸角タイル**（角丸は見た目のためのみ。ブラウザタブでの視認性を確保）
- **PNG 系（maskable / apple-touch-icon）**: 全面を `#0b0f14` で塗りつぶす（maskable は全出血が必須。iOS は OS 側がマスクする）
- `prefers-color-scheme` 分岐は**しない**。ダークタイル固定＝アイデンティティの一致。ライトなタブバー上でも沈まない（3色とも中間明度）

### 色

製品アクセント `#1d9bf0`（`app/src/styles.css` の `--accent` と同一出自）の**明度ランプ**。合流に向けて濃くなり、「束ねられて1つになる」を色でも語る。

| 役割 | 色 | 備考 |
|---|---|---|
| ストリーム 1（上） | `#8ed0f9` | 淡い青 |
| ストリーム 2（中） | `#1d9bf0` | アクセント本体 |
| ストリーム 3（下） | `#4db2f4` | 中間 |
| 合流後の1本 | `#0c63ad` | 深い青 |
| 背景タイル | `#0b0f14` | `theme_color` と一致 |

初期値は実装時に微調整してよいが、「アクセント色相の明度ランプであること」「合流で濃くなること」は変えない。

**Provider ブランドカラーは採用しない。** Mastodon と Misskey は同じ ActivityPub ファミリであり線とブランドが1対1に対応せず、mixi2 にはブランドロゴ使用ガイドラインが存在し、Provider 数は今後増える（mixi2 サポート予定）。詳細は [ADR-0008](./adr/0008-app-icon-static-svg-assets.md)。

## アセット一覧

すべて `app/public/` に配置する。

| ファイル | サイズ | 用途 |
|---|---|---|
| `icon.svg` | — | **唯一のデザインソース**。ブラウザタブのファビコン本体 |
| `icon-32.png` | 32×32 | 旧ブラウザ向け PNG フォールバック |
| `icon-192.png` | 192×192 | PWA manifest（`any`） |
| `icon-512.png` | 512×512 | PWA manifest（`any` + `maskable` 兼用） |
| `apple-touch-icon.png` | 180×180 | iOS ホーム画面（全出血ダーク背景） |

**`favicon.ico` は作成しない。** モダンブラウザは SVG/PNG の link で足りる。

## 配線

### `app/index.html`

```html
<link rel="icon" type="image/svg+xml" href="/icon.svg" />
<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
```

既存の `<link rel="apple-touch-icon" href="/icon-192.png" />` は上記に置き換える。`rel="manifest"` は vite-plugin-pwa が注入済みなので触らない。

### `app/vite.config.ts`（manifest の icons）

```ts
icons: [
  { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
  { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
],
```

エントリ自体は現状から変更なし（ファイルの意味が変わるだけ）。ついでに manifest の `lang` を `'ja'` にする（現状は既定の `'en'`）。

## 生成パイプライン

- **`app/public/icon.svg` が唯一のソース。** すべての PNG はここからラスター化する
- 新スクリプト **`scripts/render-icons.mjs`**（`sharp` は devDependency、`npm run icons` で実行）が `icon-32/192/512.png` と `apple-touch-icon.png` を生成する。**PNG はコミットする**
- ラスター時は SVG の丸角クリップ（`clip-path="url(#tile-clip)"`）を除去して**全出血**で出力する（maskable 要件。丸角はファビコン表示専用の見た目）
- **`npm run build` はアイコンに一切触れない。** `scripts/gen-icons.mjs` は削除し、build スクリプトの `node scripts/gen-icons.mjs &&` プレフィックスも外す → 上書きの罠を構造的に撤去する

### アイコン変更手順

```bash
# 1. app/public/icon.svg を編集（唯一のソース）
# 2. PNG を再生成
npm run icons
# 3. svg と png をまとめてコミット
```

## 検証チェックリスト

- [ ] ブラウザタブに合流ストリームのアイコンが出る（空白でない）
- [ ] 16px 表示で「3本 → 1本」が判別できる
- [ ] PWA インストール要件を満たす（manifest に 192 + 512 + maskable）
- [ ] maskable 表示でグリフがセーフゾーン（中央 80%）内に収まる
- [ ] iOS ホーム画面にダークタイルのアイコンが出る（角は OS がマスク）
- [ ] `npm run build` を2回実行しても `app/public/` のアイコンが変化しない（`git status` がクリーン）
