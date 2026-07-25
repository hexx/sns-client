import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// app/ を root としてビルド。成果物は app/dist → Worker の assets が配信。
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'SNS Client',
        short_name: 'SNS',
        description: '複数 SNS を1画面で扱う PWA クライアント（MVP: Bluesky）',
        theme_color: '#0b0f14',
        background_color: '#0b0f14',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: { maximumFileSizeToCacheInBytes: 5 * 1024 * 1024 },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // 開発時は /api をローカル Worker (wrangler dev) へプロキシ
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
