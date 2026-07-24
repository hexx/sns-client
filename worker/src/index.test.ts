// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';
import { BskyAuthError, createPost, getTimeline, resetSession, uploadMedia } from './bsky';

// bsky モジュールをモジュール境界でモック（instanceof のため BskyAuthError は実物を維持）
vi.mock('./bsky', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bsky')>();
  return {
    ...actual,
    getTimeline: vi.fn(),
    uploadMedia: vi.fn(),
    createPost: vi.fn(),
    resetSession: vi.fn(),
  };
});

function makeEnv(assetsFetch = vi.fn()): Env {
  return {
    ASSETS: { fetch: assetsFetch } as unknown as Env['ASSETS'],
    BSKY_HANDLE: 'h',
    BSKY_APP_PASSWORD: 'p',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // bskyRoute がエラー時に console.error するのを抑制（テストでは期待される出力）
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('fetch ルーティング', () => {
  it('health: secrets 設定済み → configured', async () => {
    const res = await worker.fetch(new Request('https://x/api/health'), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; session: string };
    expect(body.ok).toBe(true);
    expect(body.session).toBe('configured');
  });

  it('health: secrets 無し → missing-secrets', async () => {
    const res = await worker.fetch(new Request('https://x/api/health'), {
      ASSETS: { fetch: vi.fn() } as unknown as Env['ASSETS'],
    });
    expect(((await res.json()) as { session: string }).session).toBe('missing-secrets');
  });

  it('timeline GET → 200 と getTimeline の結果', async () => {
    vi.mocked(getTimeline).mockResolvedValue({ posts: [], nextCursor: 'c' });
    const res = await worker.fetch(new Request('https://x/api/timeline'), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posts: [], nextCursor: 'c' });
    expect(getTimeline).toHaveBeenCalledWith('h', 'p', undefined);
  });

  it('timeline GET: cursor を透過する', async () => {
    vi.mocked(getTimeline).mockResolvedValue({ posts: [], nextCursor: null });
    await worker.fetch(new Request('https://x/api/timeline?cursor=abc'), makeEnv());
    expect(getTimeline).toHaveBeenCalledWith('h', 'p', 'abc');
  });

  it('media POST → 200 と uploadMedia の結果', async () => {
    const blobRef = { $type: 'blob', ref: 'x' };
    vi.mocked(uploadMedia).mockResolvedValue(blobRef);
    const res = await worker.fetch(
      new Request('https://x/api/media', {
        method: 'POST',
        body: new Uint8Array([1, 2, 3]),
        headers: { 'content-type': 'image/png' },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ blob: blobRef });
    expect(uploadMedia).toHaveBeenCalledWith('h', 'p', expect.any(ArrayBuffer), 'image/png');
  });

  it('post POST → 201 と createPost の結果', async () => {
    const created = { id: 'p1' };
    vi.mocked(createPost).mockResolvedValue(created as never);
    const res = await worker.fetch(
      new Request('https://x/api/post', {
        method: 'POST',
        body: JSON.stringify({ text: 'hi' }),
        headers: { 'content-type': 'application/json' },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(created);
    expect(createPost).toHaveBeenCalledWith('h', 'p', { text: 'hi' });
  });

  it('未知の /api/* → 501', async () => {
    const res = await worker.fetch(new Request('https://x/api/unknown'), makeEnv());
    expect(res.status).toBe(501);
  });

  it('非 /api → ASSETS.fetch（SPA フォールバック）', async () => {
    const assetsFetch = vi.fn().mockResolvedValue(new Response('spa'));
    const res = await worker.fetch(new Request('https://x/some/page'), makeEnv(assetsFetch));
    expect(assetsFetch).toHaveBeenCalled();
    expect(await res.text()).toBe('spa');
  });
});

describe('エラーハンドリング（isAuthError の挙動を含む）', () => {
  it('BskyAuthError → 503', async () => {
    vi.mocked(getTimeline).mockRejectedValue(new BskyAuthError('missing-secrets'));
    const res = await worker.fetch(new Request('https://x/api/timeline'), makeEnv());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'missing-secrets' });
    expect(resetSession).not.toHaveBeenCalled();
  });

  it('認証系エラー（status 401）→ 502 ＋ resetSession', async () => {
    vi.mocked(getTimeline).mockRejectedValue({ status: 401 });
    const res = await worker.fetch(new Request('https://x/api/timeline'), makeEnv());
    expect(res.status).toBe(502);
    expect(resetSession).toHaveBeenCalled();
  });

  it('認証系エラー（メッセージ ExpiredToken）→ 502 ＋ resetSession', async () => {
    vi.mocked(getTimeline).mockRejectedValue(new Error('ExpiredToken'));
    const res = await worker.fetch(new Request('https://x/api/timeline'), makeEnv());
    expect(res.status).toBe(502);
    expect(resetSession).toHaveBeenCalled();
  });

  it('汎用エラー → 502 ＋ resetSession せず ＋ 詳細を漏らさない', async () => {
    vi.mocked(getTimeline).mockRejectedValue(new Error('secret internal detail'));
    const res = await worker.fetch(new Request('https://x/api/timeline'), makeEnv());
    expect(res.status).toBe(502);
    expect(resetSession).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
