/**
 * sns-client Worker (BFF + Static Assets)
 *
 * /api/* を BFF で処理し、それ以外は静的アセット(SPA)へフォールバック。
 */
import { API } from '../../shared/constants';
import type { PostInputWire } from '../../shared/types';
import { BskyAuthError, createPost, getTimeline, resetSession, uploadMedia } from './bsky';

export interface Env {
  ASSETS: Fetcher;
  BSKY_HANDLE?: string;
  BSKY_APP_PASSWORD?: string;
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
  });
}

/** 再ログインを促すべき認証系エラーか */
function isAuthError(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return status === 401 || /ExpiredToken|InvalidToken|AuthFactor|authentication|unauthorized/i.test(String(e));
}

/**
 * BFF ルート共通のエラーハンドリング。
 * - 認証未設定 (BskyAuthError) → 503
 * - 認証系エラー → セッションを破棄し次回リクエストで再ログイン
 * - その他 → 詳細はサーバ側ログのみ記録し、クライアントへは汎用メッセージ（情報漏洩防止）
 */
async function bskyRoute(label: string, fn: () => Promise<unknown>, okStatus = 200): Promise<Response> {
  try {
    return json(await fn(), { status: okStatus });
  } catch (e) {
    if (e instanceof BskyAuthError) return json({ error: e.message }, { status: 503 });
    if (isAuthError(e)) resetSession();
    console.error(`[${label}]`, e);
    return json({ error: 'Internal server error' }, { status: 502 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === API.health) {
      const secretsReady = Boolean(env.BSKY_HANDLE && env.BSKY_APP_PASSWORD);
      return json({
        ok: true,
        service: 'sns-client',
        session: secretsReady ? 'configured' : 'missing-secrets',
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === API.timeline && request.method === 'GET') {
      const cursor = url.searchParams.get('cursor') ?? undefined;
      return bskyRoute('api/timeline', () => getTimeline(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD, cursor));
    }

    if (url.pathname === API.media && request.method === 'POST') {
      const mimeType = request.headers.get('content-type') || 'application/octet-stream';
      const bytes = await request.arrayBuffer();
      return bskyRoute('api/media', async () => ({
        blob: await uploadMedia(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD, bytes, mimeType),
      }));
    }

    if (url.pathname === API.post && request.method === 'POST') {
      const input = (await request.json()) as PostInputWire;
      return bskyRoute('api/post', () => createPost(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD, input), 201);
    }

    if (url.pathname.startsWith(API.prefix)) {
      return json({ error: 'not implemented', path: url.pathname }, { status: 501 });
    }

    // --- Static assets / SPA fallback ---
    return env.ASSETS.fetch(request);
  },
};
