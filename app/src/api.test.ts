import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import type { Source } from '../../shared/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** fetch の戻り値を模すプレーンオブジェクト（jsdom には Response がないため） */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

const bskyHome: Source = { provider: 'bluesky', kind: 'home' };
const mkHome: Source = { provider: 'misskey', kind: 'home' };

describe('api', () => {
  it('成功 → パース済み JSON を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    await expect(api.health()).resolves.toEqual({ ok: true });
  });

  it('非 ok ＋ JSON エラーボディ → body.error の ApiError（status 保持）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'bad request' }, false, 400)));
    const err = await api.health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('bad request');
    expect(err.status).toBe(400);
  });

  it('非 ok ＋ permanent フラグを保持（misskey 認証失敗）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'auth-failed', permanent: true, provider: 'misskey' }, false, 401)),
    );
    const err = await api.timeline(mkHome).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.permanent).toBe(true);
    expect(err.provider).toBe('misskey');
  });

  it('非 ok ＋ 非 JSON ボディ → ステータス文字列で throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      }),
    );
    await expect(api.health()).rejects.toThrow('500');
  });

  it('views / providers を取得', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([])));
    await expect(api.views()).resolves.toEqual([]);
    await expect(api.providers()).resolves.toEqual([]);
  });

  it('timeline(source, cursor) → provider/kind/cursor を query に', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ posts: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    await api.timeline(bskyHome, 'abc');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/timeline?');
    expect(url).toContain('provider=bluesky');
    expect(url).toContain('kind=home');
    expect(url).toContain('cursor=abc');
  });

  it('timeline(source) → cursor 無し', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ posts: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    await api.timeline(mkHome);
    expect(fetchMock.mock.calls[0][0]).not.toContain('cursor=');
  });

  it('uploadMedia(provider, bytes, mime, alt) → provider/alt を query に', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ blob: 'file-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const bytes = new ArrayBuffer(8);
    await api.uploadMedia('misskey', bytes, 'image/png', 'desc');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/media?');
    expect(url).toContain('provider=misskey');
    expect(url).toContain('alt=desc');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: 'POST', body: bytes, headers: expect.objectContaining({ 'content-type': 'image/png' }) }),
    );
  });

  it('post → POST・JSON ボディ（provider 含む）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'p1' }));
    vi.stubGlobal('fetch', fetchMock);
    await api.post({ provider: 'misskey', text: 'hi' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/post',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ provider: 'misskey', text: 'hi' }) }),
    );
  });
});
