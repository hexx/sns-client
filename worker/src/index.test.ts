// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';
import { BskyAuthError, createPost as bskyPost, getTimeline as bskyTimeline, listSources as bskySources, resetSession, uploadMedia as bskyUpload } from './bsky';
import { MisskeyApiError, MisskeyAuthError, createPost as misskeyPost, getComposeCharLimit, getEmojiList as misskeyEmojis, getTimeline as misskeyTimeline, listSources as misskeySources, react as misskeyReact, uploadMedia as misskeyUpload } from './misskey';

// モジュール境界でモック（instanceof のため AuthError 系は実物を維持）
vi.mock('./bsky', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bsky')>();
  return {
    ...actual,
    getTimeline: vi.fn(),
    uploadMedia: vi.fn(),
    createPost: vi.fn(),
    resetSession: vi.fn(),
    listSources: vi.fn(),
  };
});
vi.mock('./misskey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./misskey')>();
  return {
    ...actual,
    getTimeline: vi.fn(),
    uploadMedia: vi.fn(),
    createPost: vi.fn(),
    getComposeCharLimit: vi.fn(),
    react: vi.fn(),
    getEmojiList: vi.fn(),
    listSources: vi.fn(),
  };
});

function makeEnv(assetsFetch = vi.fn()): Env {
  return {
    ASSETS: { fetch: assetsFetch } as unknown as Env['ASSETS'],
    BSKY_HANDLE: 'h',
    BSKY_APP_PASSWORD: 'p',
    MISSKEY_INSTANCE_URL: 'https://misskey.io',
    MISSKEY_TOKEN: 'mk-token',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getComposeCharLimit).mockResolvedValue(3000);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('health / views / providers', () => {
  it('health: secrets 設定済み → configured', async () => {
    const res = await worker.fetch(new Request('https://x/api/health'), makeEnv());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { session: string }).session).toBe('configured');
  });

  it('views: 固定プリセット（統合ホーム=bsky+misskey）を返す', async () => {
    const res = await worker.fetch(new Request('https://x/api/views'), makeEnv());
    const views = (await res.json()) as { id: string; sources: { provider: string }[] }[];
    expect(views[0].id).toBe('home');
    expect(views[0].sources.map((s) => s.provider)).toEqual(['bluesky', 'misskey']);
  });

  it('providers: 設定状態と compose 設定を返す（misskey の上限は meta 由来）', async () => {
    const res = await worker.fetch(new Request('https://x/api/providers'), makeEnv());
    const list = (await res.json()) as { provider: string; configured: boolean; compose: { charLimit: number; unit: string } }[];
    const bsky = list.find((p) => p.provider === 'bluesky')!;
    const mk = list.find((p) => p.provider === 'misskey')!;
    expect(bsky).toEqual({ provider: 'bluesky', configured: true, compose: { charLimit: 300, unit: 'grapheme' } });
    expect(mk.configured).toBe(true);
    expect(mk.compose).toEqual({ charLimit: 3000, unit: 'char' });
  });

  it('providers: MISSKEY_TOKEN 無し → misskey configured=false', async () => {
    const env = makeEnv();
    delete env.MISSKEY_TOKEN;
    const res = await worker.fetch(new Request('https://x/api/providers'), env);
    const list = (await res.json()) as { provider: string; configured: boolean }[];
    expect(list.find((p) => p.provider === 'misskey')!.configured).toBe(false);
  });
});

describe('timeline dispatch', () => {
  it('provider=bluesky → bskyTimeline', async () => {
    vi.mocked(bskyTimeline).mockResolvedValue({ posts: [], nextCursor: 'c' });
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=bluesky&cursor=abc'), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posts: [], nextCursor: 'c' });
    expect(bskyTimeline).toHaveBeenCalledWith('h', 'p', { provider: 'bluesky', kind: 'home' }, 'abc');
    expect(misskeyTimeline).not.toHaveBeenCalled();
  });

  it('kind=list&id → source に id を載せて dispatch', async () => {
    vi.mocked(misskeyTimeline).mockResolvedValue({ posts: [], nextCursor: null });
    const res = await worker.fetch(
      new Request('https://x/api/timeline?provider=misskey&kind=list&id=L1'),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(misskeyTimeline).toHaveBeenCalledWith(expect.anything(), { provider: 'misskey', kind: 'list', id: 'L1' }, undefined);
  });

  it('kind 不正 → 400', async () => {
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=misskey&kind=feed'), makeEnv());
    expect(res.status).toBe(400);
  });

  it('kind=list で id 無し → 400', async () => {
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=bluesky&kind=list'), makeEnv());
    expect(res.status).toBe(400);
  });
});

describe('sources catalog', () => {
  it('両プロバイダの Source 一覧を返す', async () => {
    vi.mocked(bskySources).mockResolvedValue([{ source: { provider: 'bluesky', kind: 'home' }, name: 'ホーム' }]);
    vi.mocked(misskeySources).mockResolvedValue([{ source: { provider: 'misskey', kind: 'home' }, name: 'ホーム' }]);
    const res = await worker.fetch(new Request('https://x/api/sources'), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { provider: 'bluesky', options: [{ source: { provider: 'bluesky', kind: 'home' }, name: 'ホーム' }] },
      { provider: 'misskey', options: [{ source: { provider: 'misskey', kind: 'home' }, name: 'ホーム' }] },
    ]);
  });

  it('片方失敗しても他方は返る（error フラグ付き）', async () => {
    vi.mocked(bskySources).mockRejectedValue(new Error('boom'));
    vi.mocked(misskeySources).mockResolvedValue([{ source: { provider: 'misskey', kind: 'home' }, name: 'ホーム' }]);
    const res = await worker.fetch(new Request('https://x/api/sources'), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string; options: unknown[]; error?: boolean }[];
    expect(body[0]).toEqual({ provider: 'bluesky', options: [], error: true });
    expect(body[1].options).toHaveLength(1);
  });

  it('provider=misskey → misskeyTimeline', async () => {
    vi.mocked(misskeyTimeline).mockResolvedValue({ posts: [], nextCursor: 'n1' });
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=misskey'), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posts: [], nextCursor: 'n1' });
    expect(misskeyTimeline).toHaveBeenCalled();
    expect(bskyTimeline).not.toHaveBeenCalled();
  });

  it('provider 不正 → 400', async () => {
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=mixi'), makeEnv());
    expect(res.status).toBe(400);
  });


  it('provider=mastodon（型上予約のみ・未実装）→ 400', async () => {
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=mastodon'), makeEnv());
    expect(res.status).toBe(400);
  });
});

describe('media / post dispatch', () => {
  it('media provider=misskey → drive fileId（alt 透過）', async () => {
    vi.mocked(misskeyUpload).mockResolvedValue('file-1');
    const res = await worker.fetch(
      new Request('https://x/api/media?provider=misskey&alt=desc', {
        method: 'POST',
        body: new Uint8Array([1, 2]),
        headers: { 'content-type': 'image/png' },
      }),
      makeEnv(),
    );
    expect(await res.json()).toEqual({ blob: 'file-1' });
    expect(misskeyUpload).toHaveBeenCalledWith(expect.anything(), expect.any(ArrayBuffer), 'image/png', 'desc');
  });

  it('media provider=bluesky → bskyUpload', async () => {
    const blobRef = { $type: 'blob' };
    vi.mocked(bskyUpload).mockResolvedValue(blobRef);
    const res = await worker.fetch(
      new Request('https://x/api/media?provider=bluesky', {
        method: 'POST',
        body: new Uint8Array([1]),
        headers: { 'content-type': 'image/png' },
      }),
      makeEnv(),
    );
    expect(await res.json()).toEqual({ blob: blobRef });
  });

  it('post provider=misskey → misskeyPost（201）', async () => {
    const created = { id: 'n1', provider: 'misskey' };
    vi.mocked(misskeyPost).mockResolvedValue(created as never);
    const res = await worker.fetch(
      new Request('https://x/api/post', {
        method: 'POST',
        body: JSON.stringify({ provider: 'misskey', text: 'hi' }),
        headers: { 'content-type': 'application/json' },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(created);
  });

  it('post provider=bluesky → bskyPost（201）', async () => {
    vi.mocked(bskyPost).mockResolvedValue({ id: 'p1' } as never);
    const res = await worker.fetch(
      new Request('https://x/api/post', {
        method: 'POST',
        body: JSON.stringify({ provider: 'bluesky', text: 'hi' }),
        headers: { 'content-type': 'application/json' },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(201);
    expect(bskyPost).toHaveBeenCalledWith('h', 'p', { provider: 'bluesky', text: 'hi' });
  });

  it('post provider 不正 → 400', async () => {
    const res = await worker.fetch(
      new Request('https://x/api/post', {
        method: 'POST',
        body: JSON.stringify({ text: 'hi' }),
        headers: { 'content-type': 'application/json' },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });
});

function reactionRequest(body: unknown): Request {
  return new Request('https://x/api/reactions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('reactions / emojis dispatch', () => {
  it('reaction あり → create、{reaction} をエコー（200）', async () => {
    vi.mocked(misskeyReact).mockResolvedValue(undefined);
    const res = await worker.fetch(reactionRequest({ provider: 'misskey', postId: 'n1', reaction: ':kawaii:' }), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reaction: ':kawaii:' });
    expect(misskeyReact).toHaveBeenCalledWith(expect.anything(), 'n1', ':kawaii:');
  });

  it('reaction なし → delete、{} を返す（200）', async () => {
    vi.mocked(misskeyReact).mockResolvedValue(undefined);
    const res = await worker.fetch(reactionRequest({ provider: 'misskey', postId: 'n1' }), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(misskeyReact).toHaveBeenCalledWith(expect.anything(), 'n1', undefined);
  });

  it('provider=bluesky → 400 unsupported（Misskey のみ）', async () => {
    const res = await worker.fetch(reactionRequest({ provider: 'bluesky', postId: 'p1', reaction: 'x' }), makeEnv());
    expect(res.status).toBe(400);
    expect(misskeyReact).not.toHaveBeenCalled();
  });

  it('postId 空 → 400', async () => {
    const res = await worker.fetch(reactionRequest({ provider: 'misskey', postId: '' }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('reaction が空文字 → 400', async () => {
    const res = await worker.fetch(reactionRequest({ provider: 'misskey', postId: 'n1', reaction: '' }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('ボディ不正（JSON 壊れ）→ 400', async () => {
    const res = await worker.fetch(
      new Request('https://x/api/reactions', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('MisskeyApiError → 409 ＋ code を転送', async () => {
    vi.mocked(misskeyReact).mockRejectedValue(new MisskeyApiError(409, 'misskey create 400', 'ALREADY_REACTED'));
    const res = await worker.fetch(reactionRequest({ provider: 'misskey', postId: 'n1', reaction: '👍' }), makeEnv());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'ALREADY_REACTED' });
  });

  it('misskey 認証系エラー → 401 permanent', async () => {
    vi.mocked(misskeyReact).mockRejectedValue({ status: 401 });
    const res = await worker.fetch(reactionRequest({ provider: 'misskey', postId: 'n1', reaction: '👍' }), makeEnv());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { permanent: boolean }).permanent).toBe(true);
  });

  it('emojis: provider=misskey → compact な一覧（200）', async () => {
    vi.mocked(misskeyEmojis).mockResolvedValue([{ name: 'a', url: 'u' }]);
    const res = await worker.fetch(new Request('https://x/api/emojis?provider=misskey'), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: 'a', url: 'u' }]);
  });

  it('emojis: provider 無し/他 → 400', async () => {
    expect((await worker.fetch(new Request('https://x/api/emojis'), makeEnv())).status).toBe(400);
    expect((await worker.fetch(new Request('https://x/api/emojis?provider=bluesky'), makeEnv())).status).toBe(400);
  });
});

describe('エラーハンドリング（プロバイダ対応）', () => {
  it('BskyAuthError → 503', async () => {
    vi.mocked(bskyTimeline).mockRejectedValue(new BskyAuthError('missing-secrets'));
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=bluesky'), makeEnv());
    expect(res.status).toBe(503);
  });

  it('MisskeyAuthError → 503', async () => {
    vi.mocked(misskeyTimeline).mockRejectedValue(new MisskeyAuthError('missing-secrets'));
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=misskey'), makeEnv());
    expect(res.status).toBe(503);
  });

  it('bsky 認証系エラー → 502 ＋ resetSession（セルフヒーリング）', async () => {
    vi.mocked(bskyTimeline).mockRejectedValue({ status: 401 });
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=bluesky'), makeEnv());
    expect(res.status).toBe(502);
    expect(resetSession).toHaveBeenCalled();
  });

  it('misskey 認証系エラー → 401 permanent（resetSession しない）', async () => {
    vi.mocked(misskeyTimeline).mockRejectedValue({ status: 401 });
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=misskey'), makeEnv());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { permanent: boolean }).permanent).toBe(true);
    expect(resetSession).not.toHaveBeenCalled();
  });

  it('汎用エラー → 502 ＋ 詳細を漏らさない', async () => {
    vi.mocked(misskeyTimeline).mockRejectedValue(new Error('secret internal detail'));
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=misskey'), makeEnv());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
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
