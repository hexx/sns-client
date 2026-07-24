import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** fetch の戻り値を模すプレーンオブジェクト（jsdom には Response がないため） */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('api', () => {
  it('成功 → パース済み JSON を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    await expect(api.health()).resolves.toEqual({ ok: true });
  });

  it('非 ok ＋ JSON エラーボディ → body.error で throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'bad request' }, false, 400)),
    );
    await expect(api.health()).rejects.toThrow('bad request');
  });

  it('非 ok ＋ JSON エラーボディ無し → ステータス文字列で throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 404)));
    await expect(api.health()).rejects.toThrow('404');
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

  it('timeline(cursor) → URL に ?cursor= を付与', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ posts: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    await api.timeline('abc');
    expect(fetchMock).toHaveBeenCalledWith('/api/timeline?cursor=abc', expect.anything());
  });

  it('timeline() → cursor 無し', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ posts: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    await api.timeline();
    expect(fetchMock).toHaveBeenCalledWith('/api/timeline', expect.anything());
  });

  it('uploadMedia → POST・bytes・content-type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ blob: 'b' }));
    vi.stubGlobal('fetch', fetchMock);
    const bytes = new ArrayBuffer(8);
    await api.uploadMedia(bytes, 'image/png');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/media',
      expect.objectContaining({
        method: 'POST',
        body: bytes,
        headers: expect.objectContaining({ 'content-type': 'image/png' }),
      }),
    );
  });

  it('post → POST・JSON ボディ', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'p1' }));
    vi.stubGlobal('fetch', fetchMock);
    await api.post({ text: 'hi' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/post',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'hi' }) }),
    );
  });
});
