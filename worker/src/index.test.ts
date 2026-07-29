// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';
import { BskyAuthError, createPost as bskyPost, getTimeline as bskyTimeline, likePost as bskyLike, listSources as bskySources, repostPost as bskyRepost, resetSession, unlikePost as bskyUnlike, unrepostPost as bskyUnrepost, uploadMedia as bskyUpload } from './bsky';
import { MisskeyApiError, MisskeyAuthError, createPost as misskeyPost, getComposeCharLimit, getEmojiList as misskeyEmojis, getTimeline as misskeyTimeline, listDestinations as misskeyDestinations, listSources as misskeySources, react as misskeyReact, renote as misskeyRenote, uploadMedia as misskeyUpload } from './misskey';
import { getTimeline as nostrTimeline } from './nostr';

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
    likePost: vi.fn(),
    unlikePost: vi.fn(),
    repostPost: vi.fn(),
    unrepostPost: vi.fn(),
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
    listDestinations: vi.fn(),
    renote: vi.fn(),
  };
});
// nostr は実体が WebSocket を開くため、ルーティングテストではモック（実挙動は nostr.test.ts で検証）
vi.mock('./nostr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./nostr')>();
  return { ...actual, getTimeline: vi.fn() };
});

function makeEnv(assetsFetch = vi.fn()): Env {
  return {
    ASSETS: { fetch: assetsFetch } as unknown as Env['ASSETS'],
    VIEWS: { get: vi.fn(), put: vi.fn() } as unknown as Env['VIEWS'],
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

  it('providers: nostr は常に configured・compose 無し（読み取り専用、§5.3）', async () => {
    const res = await worker.fetch(new Request('https://x/api/providers'), makeEnv());
    const list = (await res.json()) as { provider: string; configured: boolean; compose?: unknown }[];
    const nostr = list.find((p) => p.provider === 'nostr')!;
    expect(nostr.configured).toBe(true);
    expect(nostr.compose).toBeUndefined();
  });
});

describe('nostr ルーティング（読み取り専用）', () => {
  it('timeline: pubkey + id → nostrTimeline に dispatch', async () => {
    vi.mocked(nostrTimeline).mockResolvedValue({ posts: [], nextCursor: null });
    const res = await worker.fetch(
      new Request('https://x/api/timeline?provider=nostr&kind=pubkey&id=npub1abc'),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(nostrTimeline).toHaveBeenCalledWith({ provider: 'nostr', kind: 'pubkey', id: 'npub1abc' }, undefined);
  });

  it('timeline: pubkey で id 無し → 400', async () => {
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=nostr&kind=pubkey'), makeEnv());
    expect(res.status).toBe(400);
  });

  it('timeline: 不正な kind → 400', async () => {
    const res = await worker.fetch(new Request('https://x/api/timeline?provider=nostr&kind=home'), makeEnv());
    expect(res.status).toBe(400);
  });

  it('timeline: 不正な npub → 400（NostrError をマップ）', async () => {
    vi.mocked(nostrTimeline).mockImplementation(async () => {
      const { NostrError } = await import('./nostr');
      throw new NostrError(400, 'invalid npub');
    });
    const res = await worker.fetch(
      new Request('https://x/api/timeline?provider=nostr&kind=pubkey&id=npub1bad'),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid npub');
  });

  it('post: nostr は投稿不可 → 400', async () => {
    const res = await worker.fetch(new Request('https://x/api/post', {
      method: 'POST',
      body: JSON.stringify({ provider: 'nostr', text: 'hi' }),
    }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('media: nostr は 400', async () => {
    const res = await worker.fetch(new Request('https://x/api/media?provider=nostr', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('reposts: nostr は 400', async () => {
    const res = await worker.fetch(new Request('https://x/api/reposts', {
      method: 'POST',
      body: JSON.stringify({ provider: 'nostr', ref: 'x' }),
    }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('views PUT: nostr source（pubkey+id）を受け付ける', async () => {
    const { env, kv } = (() => {
      const store = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
      return { env: { ...makeEnv(), VIEWS: store as unknown as Env['VIEWS'] }, kv: store };
    })();
    const body = [{ id: 'n', name: 'Nostr', sources: [{ provider: 'nostr', kind: 'pubkey', id: 'npub1abc' }] }];
    const res = await worker.fetch(new Request('https://x/api/views', {
      method: 'PUT',
      body: JSON.stringify(body),
    }), env);
    expect(res.status).toBe(200);
    expect(kv.put).toHaveBeenCalled();
  });

  it('views PUT: nostr source で id 無し → 400', async () => {
    const env = { ...makeEnv(), VIEWS: { get: vi.fn(), put: vi.fn() } as unknown as Env['VIEWS'] };
    const body = [{ id: 'n', name: 'Nostr', sources: [{ provider: 'nostr', kind: 'pubkey' }] }];
    const res = await worker.fetch(new Request('https://x/api/views', {
      method: 'PUT',
      body: JSON.stringify(body),
    }), env);
    expect(res.status).toBe(400);
  });
});

describe('views（KV カスタム View）', () => {
  function envWithKv(getImpl: () => unknown = () => null) {
    const kv = { get: vi.fn(async () => getImpl()), put: vi.fn(async () => {}) };
    const env: Env = { ...makeEnv(), VIEWS: kv as unknown as Env['VIEWS'] };
    return { env, kv };
  }

  it('KV 未設定 → プリセット', async () => {
    const { env } = envWithKv(() => null);
    const res = await worker.fetch(new Request('https://x/api/views'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'home', name: 'ホーム', sources: expect.any(Array) }]);
  });

  it('KV に保存済み → そちらを優先', async () => {
    const stored = [{ id: 'v1', name: '技術', sources: [{ provider: 'misskey', kind: 'list', id: 'L1' }] }];
    const { env } = envWithKv(() => stored);
    const res = await worker.fetch(new Request('https://x/api/views'), env);
    expect(await res.json()).toEqual(stored);
  });

  it('KV 障害 → プリセットへフォールバック', async () => {
    const kv = { get: vi.fn(async () => { throw new Error('kv down'); }), put: vi.fn(async () => {}) };
    const env: Env = { ...makeEnv(), VIEWS: kv as unknown as Env['VIEWS'] };
    const res = await worker.fetch(new Request('https://x/api/views'), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }[])[0].id).toBe('home');
  });

  it('VIEWS バインド無し → プリセット（段階ロールアウト互換）', async () => {
    const env = makeEnv();
    delete (env as { VIEWS?: unknown }).VIEWS;
    const res = await worker.fetch(new Request('https://x/api/views'), env);
    expect(res.status).toBe(200);
  });

  it('PUT: 有効な View[] → KV に保存してエコー', async () => {
    const { env, kv } = envWithKv();
    const views = [
      { id: 'v1', name: '技術', sources: [{ provider: 'misskey', kind: 'list', id: 'L1' }, { provider: 'bluesky', kind: 'home' }] },
    ];
    const res = await worker.fetch(
      new Request('https://x/api/views', { method: 'PUT', body: JSON.stringify(views) }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(views);
    expect(kv.put).toHaveBeenCalledWith('views', JSON.stringify(views));
  });

  it('PUT: misskey channel Source（id 付き）→ 200（docs/misskey-channel-source-spec.md）', async () => {
    const { env } = envWithKv();
    const views = [{ id: 'v1', name: 'チャンネル', sources: [{ provider: 'misskey', kind: 'channel', id: 'C1' }] }];
    const res = await worker.fetch(
      new Request('https://x/api/views', { method: 'PUT', body: JSON.stringify(views) }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it.each([
    ['配列でない', JSON.stringify({ id: 'v1' })],
    ['id 無し', JSON.stringify([{ name: 'x', sources: [{ provider: 'bluesky', kind: 'home' }] }])],
    ['id 重複', JSON.stringify([{ id: 'a', name: 'x', sources: [{ provider: 'bluesky', kind: 'home' }] }, { id: 'a', name: 'y', sources: [{ provider: 'bluesky', kind: 'home' }] }])],
    ['sources 空', JSON.stringify([{ id: 'a', name: 'x', sources: [] }])],
    ['kind 不正', JSON.stringify([{ id: 'a', name: 'x', sources: [{ provider: 'misskey', kind: 'feed' }] }])],
    ['id 必須の kind で id 無し', JSON.stringify([{ id: 'a', name: 'x', sources: [{ provider: 'bluesky', kind: 'list' }] }])],
    ['misskey channel で id 無し', JSON.stringify([{ id: 'a', name: 'x', sources: [{ provider: 'misskey', kind: 'channel' }] }])],
  ])('PUT 不正 → 400（%s）', async (_label, body) => {
    const res = await worker.fetch(new Request('https://x/api/views', { method: 'PUT', body }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('PUT: VIEWS 未バインド → 503', async () => {
    const env = makeEnv();
    delete (env as { VIEWS?: unknown }).VIEWS;
    const res = await worker.fetch(
      new Request('https://x/api/views', { method: 'PUT', body: '[]' }),
      env,
    );
    expect(res.status).toBe(503);
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

describe('destinations catalog（docs/compose-destination-spec.md §4.1）', () => {
  it('bluesky は home 静的、misskey はカタログ由来を返す', async () => {
    vi.mocked(misskeyDestinations).mockResolvedValue([
      { destination: { provider: 'misskey', kind: 'home' }, name: 'ホーム' },
      { destination: { provider: 'misskey', kind: 'channel', id: 'C1' }, name: '📺 ゲーム部' },
    ]);
    const res = await worker.fetch(new Request('https://x/api/destinations'), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { provider: 'bluesky', options: [{ destination: { provider: 'bluesky', kind: 'home' }, name: 'ホーム' }] },
      {
        provider: 'misskey',
        options: [
          { destination: { provider: 'misskey', kind: 'home' }, name: 'ホーム' },
          { destination: { provider: 'misskey', kind: 'channel', id: 'C1' }, name: '📺 ゲーム部' },
        ],
      },
    ]);
  });

  it('misskey 失敗しても bluesky home は返る（error フラグ付き）', async () => {
    vi.mocked(misskeyDestinations).mockRejectedValue(new Error('boom'));
    const res = await worker.fetch(new Request('https://x/api/destinations'), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string; options: unknown[]; error?: boolean }[];
    expect(body[0].options).toHaveLength(1);
    expect(body[1]).toEqual({ provider: 'misskey', options: [], error: true });
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

  // --- destination 検証（docs/compose-destination-spec.md §4.2） ---

  it('post destination=misskey channel → misskeyPost へ透過（201）', async () => {
    vi.mocked(misskeyPost).mockResolvedValue({ id: 'n1' } as never);
    const input = {
      provider: 'misskey',
      text: 'hi',
      destination: { provider: 'misskey', kind: 'channel', id: 'C1' },
    };
    const res = await worker.fetch(postRequest(input), makeEnv());
    expect(res.status).toBe(201);
    expect(misskeyPost).toHaveBeenCalledWith(expect.anything(), input);
  });

  it('post destination.provider 不一致 → 400', async () => {
    const res = await worker.fetch(
      postRequest({
        provider: 'misskey',
        text: 'hi',
        destination: { provider: 'bluesky', kind: 'home' },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(misskeyPost).not.toHaveBeenCalled();
  });

  it('post destination.kind 不正 → 400', async () => {
    const res = await worker.fetch(
      postRequest({
        provider: 'misskey',
        text: 'hi',
        destination: { provider: 'misskey', kind: 'antenna', id: 'A1' },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('post destination=channel で id 無し → 400', async () => {
    const res = await worker.fetch(
      postRequest({
        provider: 'misskey',
        text: 'hi',
        destination: { provider: 'misskey', kind: 'channel' },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('post destination=channel + bluesky → 400', async () => {
    const res = await worker.fetch(
      postRequest({
        provider: 'bluesky',
        text: 'hi',
        destination: { provider: 'bluesky', kind: 'channel', id: 'C1' },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(bskyPost).not.toHaveBeenCalled();
  });
});

function postRequest(body: unknown): Request {
  return new Request('https://x/api/post', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

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

  it('POST /api/likes → bskyLike に dispatch し recordUri を返す', async () => {
    vi.mocked(bskyLike).mockResolvedValue('at://did/app.bsky.feed.like/r1');
    const res = await worker.fetch(
      new Request('https://x/api/likes', { method: 'POST', body: JSON.stringify({ uri: 'at://p', cid: 'c1' }) }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recordUri: 'at://did/app.bsky.feed.like/r1' });
    expect(bskyLike).toHaveBeenCalledWith('h', 'p', 'at://p', 'c1');
  });

  it('POST /api/likes 不正ボディ → 400', async () => {
    const res = await worker.fetch(new Request('https://x/api/likes', { method: 'POST', body: '{}' }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('DELETE /api/likes → bskyUnlike に dispatch', async () => {
    vi.mocked(bskyUnlike).mockResolvedValue(undefined);
    const res = await worker.fetch(
      new Request('https://x/api/likes', { method: 'DELETE', body: JSON.stringify({ recordUri: 'at://like/r1' }) }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(bskyUnlike).toHaveBeenCalledWith('h', 'p', 'at://like/r1');
  });

  it('POST /api/reposts provider=bluesky → bskyRepost', async () => {
    vi.mocked(bskyRepost).mockResolvedValue('at://did/app.bsky.feed.repost/r1');
    const res = await worker.fetch(
      new Request('https://x/api/reposts', {
        method: 'POST',
        body: JSON.stringify({ provider: 'bluesky', ref: { uri: 'at://p', cid: 'c1' } }),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recordUri: 'at://did/app.bsky.feed.repost/r1' });
  });

  it('POST /api/reposts provider=misskey → misskeyRenote（noteId 透過）', async () => {
    vi.mocked(misskeyRenote).mockResolvedValue(undefined);
    const res = await worker.fetch(
      new Request('https://x/api/reposts', {
        method: 'POST',
        body: JSON.stringify({ provider: 'misskey', ref: 'note-1' }),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(misskeyRenote).toHaveBeenCalledWith(expect.anything(), 'note-1');
  });

  it('POST /api/reposts misskey で ref が文字列でない → 400', async () => {
    const res = await worker.fetch(
      new Request('https://x/api/reposts', {
        method: 'POST',
        body: JSON.stringify({ provider: 'misskey', ref: { uri: 'x' } }),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('DELETE /api/reposts → bskyUnrepost', async () => {
    vi.mocked(bskyUnrepost).mockResolvedValue(undefined);
    const res = await worker.fetch(
      new Request('https://x/api/reposts', { method: 'DELETE', body: JSON.stringify({ recordUri: 'at://repost/r1' }) }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(bskyUnrepost).toHaveBeenCalledWith('h', 'p', 'at://repost/r1');
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
