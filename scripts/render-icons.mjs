// app/public/icon.svg（唯一のデザインソース）から PWA/ファビコン用 PNG をラスター化する。
// アイコンを変更したとき手動で実行し（npm run icons）、生成物をコミットする。
// ビルド（npm run build）からは呼ばれない → app/public の上書き事故を構造的に防ぐ。
//
// maskable / apple-touch-icon は全出血（全面塗り）が必須なため、
// SVG の丸角クリップ（clip-path="url(#tile-clip)"）はラスター時に除去する。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(scriptDir, '..', 'app', 'public');

let svg;
try {
  svg = readFileSync(join(PUBLIC, 'icon.svg'), 'utf8');
} catch (err) {
  console.error('Failed to read icon.svg:', err.message);
  process.exit(1);
}
const fullBleed = svg.replace(' clip-path="url(#tile-clip)"', '');
if (fullBleed === svg) {
  console.error('clip-path の除去に失敗しました。icon.svg の id が tile-clip か確認してください。');
  process.exit(1);
}

const targets = [
  { file: 'icon-32.png', size: 32 }, // 旧ブラウザ向けファビコンフォールバック
  { file: 'icon-192.png', size: 192 }, // PWA manifest (any)
  { file: 'icon-512.png', size: 512 }, // PWA manifest (any + maskable 兼用)
  { file: 'apple-touch-icon.png', size: 180 }, // iOS ホーム画面
];

try {
  await Promise.all(targets.map(async ({ file, size }) => {
    const out = join(PUBLIC, file);
    await sharp(Buffer.from(fullBleed)).resize(size, size).png().toFile(out);
    console.log('wrote', out);
  }));
} catch (err) {
  console.error('Failed to render icons:', err.message);
  process.exit(1);
}
