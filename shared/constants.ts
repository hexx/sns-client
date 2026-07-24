/** BFF API パス（フロント・Worker・Service Worker で共有し、不一致を防ぐ） */
export const API = {
  prefix: '/api/',
  health: '/api/health',
  timeline: '/api/timeline',
  media: '/api/media',
  post: '/api/post',
} as const;
