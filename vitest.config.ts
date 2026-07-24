import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// テスト専用設定。app/vite.config.ts の VitePWA(injectManifest) は
// テスト実行（SW ビルド文脈）を壊すため、ここでは react() のみを使う。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./app/src/test/setup.ts'],
  },
});
