/** BFF API パス（フロント・Worker・Service Worker で共有し、不一致を防ぐ） */
export const API = {
  prefix: '/api/',
  health: '/api/health',
  views: '/api/views',
  sources: '/api/sources',
  providers: '/api/providers',
  timeline: '/api/timeline',
  media: '/api/media',
  post: '/api/post',
  reactions: '/api/reactions',
  emojis: '/api/emojis',
} as const;

/** KV: カスタム View 定義（View[] の JSON）を保存するキー */
export const VIEWS_KV_KEY = 'views';
