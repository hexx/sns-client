/// <reference lib="webworker" />
/**
 * カスタム Service Worker（injectManifest）
 *
 * 方針（仕様 §7 / §11）:
 * - アプリシェルは precache（オフライン起動）
 * - ナビゲーションは network-first。オンライン時はネットワーク応答をそのまま使い
 *   キャッシュしない（Cloudflare Access のログイン画面をキャッシュしないため）。
 *   オフライン時のみ precache した index.html へフォールバック。
 * - /api/timeline は network-first + キャッシュ（オフライン時に最後の取得成功分を表示）
 * - /api/views ・ /api/providers は network-first + キャッシュ（オフラインのコールドスタートでも View/設定を得る）
 * - その他の /api（投稿/メディア/ヘルス）は NetworkOnly（書き込みは絶対キャッシュしない）
 * - 画像（自オリジン + cdn.bsky.app）は StaleWhileRevalidate
 *
 * 更新伝播（docs/pwa-sw-update-fix-spec.md）:
 * - skipWaiting() + clientsClaim() で新 SW を即活性化し、既存クライアントの制御を即取得する。
 *   injectManifest 方式ではこれらが自動注入されないため明示的に呼ぶ（autoUpdate の controllerchange
 *   リロードは活性化を前提とする。skipWaiting 無しでは旧 SW が居座り端末が旧ビルドに固定される）。
 */
import { clientsClaim } from 'workbox-core';
import { precacheAndRoute, matchPrecache } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, NetworkOnly, StaleWhileRevalidate } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { API } from '../../shared/constants';

declare const self: ServiceWorkerGlobalScope;

// 新 SW を即活性化＋既存クライアントの制御を即取得（更新の即時伝播）
self.skipWaiting();
clientsClaim();

// 動的キャッシュ名はバージョン付き。activate 時に旧バージョンのみ削除する。
// v2: skipWaiting 導入に伴い bump。旧 v1 の timeline/meta/images キャッシュを activate 時に purge する。
const VERSION = 'v2';
const CACHE_TIMELINE = `api-timeline-${VERSION}`;
const CACHE_META = `api-meta-${VERSION}`;
const CACHE_IMAGES = `images-${VERSION}`;
const DYNAMIC_CACHES = new Set([CACHE_TIMELINE, CACHE_META, CACHE_IMAGES]);

precacheAndRoute(self.__WB_MANIFEST);

// 古い動的キャッシュを削除（workbox の precache キャッシュには一切触れない）
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(
            (k) =>
              (k.startsWith('api-timeline-') || k.startsWith('api-meta-') || k.startsWith('images-')) &&
              !DYNAMIC_CACHES.has(k),
          )
          .map((k) => caches.delete(k)),
      ),
    ),
  );
});

// ナビゲーション: network-first（キャッシュしない）＋オフライン時はシェル
registerRoute(
  ({ request }) => request.mode === 'navigate',
  async ({ request }) => {
    try {
      return await fetch(request);
    } catch {
      const shell = await matchPrecache('index.html');
      return shell ?? Response.error();
    }
  },
);

// タイムライン: network-first + キャッシュ（200 のみ）
registerRoute(
  ({ url }) => url.pathname === API.timeline,
  new NetworkFirst({
    cacheName: CACHE_TIMELINE,
    plugins: [new CacheableResponsePlugin({ statuses: [200] })],
  }),
);

// views / providers: network-first + キャッシュ（オフラインのコールドスタートでも取得できるように）
registerRoute(
  ({ url }) => url.pathname === API.views || url.pathname === API.providers,
  new NetworkFirst({
    cacheName: CACHE_META,
    plugins: [new CacheableResponsePlugin({ statuses: [200] })],
  }),
);

// その他の API: キャッシュしない
registerRoute(({ url }) => url.pathname.startsWith(API.prefix), new NetworkOnly());

// 画像: SWR（自オリジン + cdn.bsky.app + cardyb.bsky.app のみ。信頼できない第三者オリジンはキャッシュしない）
// cardyb.bsky.app は Bluesky 公式のリンクカード（LinkCard）サムネイル配信ドメイン
registerRoute(
  ({ request, url }) =>
    request.destination === 'image' &&
    (url.origin === self.location.origin ||
      url.hostname === 'cdn.bsky.app' ||
      url.hostname === 'cardyb.bsky.app'),
  new StaleWhileRevalidate({ cacheName: CACHE_IMAGES }),
);
