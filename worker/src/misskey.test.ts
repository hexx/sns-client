// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPost, loadEmojiRegistry, localEmojiName, mapNote, mfmToRich, nameToRich, getEmojiList, getTimeline, listDestinations, listSources, react, renote, MisskeyApiError, MisskeyAuthError } from './misskey';

type MkNote = Parameters<typeof mapNote>[0];

function user(over: Record<string, unknown> = {}) {
  return { id: 'u1', username: 'alice', name: 'Alice', avatarUrl: 'https://a.png', host: null, ...over };
}

function note(over: Record<string, unknown> = {}): MkNote {
  return {
    id: 'n1',
    createdAt: '2026-07-01T12:00:00Z',
    text: 'hello',
    user: user(),
    repliesCount: 1,
    renoteCount: 2,
    ...over,
  } as unknown as MkNote;
}

describe('mfmToRich', () => {
  it('text/link/mention/hashtag をセグメント化', () => {
    const { rich, plain } = mfmToRich('hi @bob #tag https://x.y', {});
    expect(rich).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'mention', handle: 'bob' },
      { type: 'text', text: ' ' },
      { type: 'hashtag', tag: 'tag' },
      { type: 'text', text: ' ' },
      { type: 'link', url: 'https://x.y' },
    ]);
    expect(plain).toBe('hi @bob #tag https://x.y');
  });

  it('カスタム絵文字は url を補う', () => {
    const { rich } = mfmToRich(':kawaii:', { kawaii: 'https://e/kawaii.png' });
    expect(rich).toEqual([{ type: 'emoji', name: 'kawaii', url: 'https://e/kawaii.png' }]);
  });

  it('Unicode 絵文字は char を持つ', () => {
    const { rich } = mfmToRich('👍', {});
    expect(rich).toEqual([{ type: 'emoji', name: '👍', char: '👍' }]);
  });

  it('装飾（bold 等）は子を展開してプレーン縮退', () => {
    const { rich, plain } = mfmToRich('**bold** normal', {});
    expect(rich).toEqual([{ type: 'text', text: 'bold normal' }]);
    expect(plain).toContain('bold');
  });
});

describe('mapNote', () => {
  it('通常ノートを Post にマッピング（ref=id, provider=misskey）', () => {
    const p = mapNote(note());
    expect(p.id).toBe('n1');
    expect(p.provider).toBe('misskey');
    expect(p.author).toEqual({ handle: 'alice', displayName: 'Alice', avatarUrl: 'https://a.png' });
    expect(p.text).toBe('hello');
    expect(p.ref).toBe('n1');
    expect(p.stats).toEqual({ replies: 1, reposts: 2, likes: 0 });
  });

  it('リモートユーザーの handle は user@host', () => {
    const p = mapNote(note({ user: user({ username: 'bob', host: 'other.example', name: null }) }));
    expect(p.author.handle).toBe('bob@other.example');
    expect(p.author.displayName).toBe('bob');
  });

  it('reactions を絵文字別にマッピング（count降順・custom url・me・likes総数）', () => {
    const p = mapNote(
      note({
        reactions: { '👍': 2, ':kawaii:': 5 },
        reactionEmojis: { kawaii: 'https://e/kawaii.png' },
        myReaction: ':kawaii:',
      }),
    );
    expect(p.stats.likes).toBe(7);
    expect(p.reactions).toEqual([
      { emoji: ':kawaii:', count: 5, emojiUrl: 'https://e/kawaii.png', me: true },
      { emoji: '👍', count: 2 },
    ]);
  });

  it('reactions 無し → reactions フィールド無し・likes=0', () => {
    const p = mapNote(note());
    expect(p.reactions).toBeUndefined();
    expect(p.stats.likes).toBe(0);
  });

  it('画像ファイルのみ media に（画像以外は除外）', () => {
    const p = mapNote(
      note({
        files: [
          { id: 'f1', url: 'https://i.png', comment: 'alt1', type: 'image/png' },
          { id: 'f2', url: 'https://v.mp4', type: 'video/mp4' },
        ],
      }),
    );
    expect(p.media).toEqual([{ type: 'image', url: 'https://i.png', alt: 'alt1' }]);
  });

  it('非 public visibility / localOnly を保持', () => {
    const p = mapNote(note({ visibility: 'followers', localOnly: true }));
    expect(p.visibility).toBe('followers');
    expect(p.localOnly).toBe(true);
  });

  it('public visibility は省略', () => {
    expect(mapNote(note({ visibility: 'public' })).visibility).toBeUndefined();
  });

  it('純粋renote → 内包ノート主体＋repostedBy＋idはrenote活動＋refは元ノート', () => {
    const inner = note({ id: 'orig', text: 'original', createdAt: '2026-06-01T00:00:00Z' });
    const wrapper = note({
      id: 'renote-activity',
      text: null,
      createdAt: '2026-07-02T00:00:00Z',
      user: user({ username: 'carol', name: 'Carol' }),
      renote: inner,
    });
    const p = mapNote(wrapper);
    expect(p.id).toBe('renote-activity');
    expect(p.text).toBe('original');
    expect(p.author.handle).toBe('alice'); // 元ノート著者
    expect(p.repostedBy?.handle).toBe('carol');
    expect(p.ref).toBe('orig'); // 返信/引用は元ノートを指す
    expect(p.createdAt).toBe('2026-07-02T00:00:00Z'); // フィード出現時刻
  });

  it('引用renote → 本文＋quote（1階層）', () => {
    const quoted = note({ id: 'q1', text: 'quoted text' });
    const p = mapNote(note({ id: 'q-outer', text: 'my comment', renote: quoted }));
    expect(p.text).toBe('my comment');
    expect(p.quote?.id).toBe('q1');
    expect(p.quote?.text).toBe('quoted text');
    expect(p.repostedBy).toBeUndefined();
  });

  it('テキスト無しのメディア付き引用も quote を設定する', () => {
    const quoted = note({ id: 'q1', text: 'quoted' });
    const p = mapNote(
      note({
        id: 'outer',
        text: null,
        files: [{ id: 'f1', url: 'https://i.png', type: 'image/png', comment: '' }],
        renote: quoted,
      }),
    );
    expect(p.quote?.id).toBe('q1');
    expect(p.media).toEqual([{ type: 'image', url: 'https://i.png', alt: '' }]);
  });

  it('引用のネストは落とす（1階層のみ）', () => {
    const deep = note({ id: 'deep', text: 'deep' });
    const quoted = note({ id: 'q1', text: 'mid', renote: deep });
    const p = mapNote(note({ id: 'outer', text: 'top', renote: quoted }));
    expect(p.quote?.id).toBe('q1');
    expect(p.quote?.quote).toBeUndefined();
  });
});

describe('mapNote: チャンネル（docs/misskey-channel-display-spec.md）', () => {
  const chX = { id: 'chX', name: 'ゲーム部' };

  it('チャンネル付きノート → {id, name} のみ映射（余剰フィールドは破棄）', () => {
    const p = mapNote(note({ channel: { ...chX, color: '#ff0000', isSensitive: false } }));
    expect(p.channel).toEqual(chX);
  });

  it('チャンネル無しノート → channel フィールドは存在しない', () => {
    expect(mapNote(note()).channel).toBeUndefined();
  });

  it('純粋renote・ケースA（外側無し・内側 X）→ 内側の X（外部renoteのフォールバック）', () => {
    const inner = note({ id: 'orig', text: 'original', channel: chX });
    const p = mapNote(note({ id: 'rn', text: null, renote: inner }));
    expect(p.channel).toEqual(chX);
    expect(p.repostedBy).toBeDefined();
  });

  it('純粋renote・ケースB（外側 X・内側 X）→ X', () => {
    const inner = note({ id: 'orig', text: 'original', channel: chX });
    const p = mapNote(note({ id: 'rn', text: null, channel: chX, renote: inner }));
    expect(p.channel).toEqual(chX);
  });

  it('純粋renote・ケースC（外側 X・内側無し）→ 外側優先で X', () => {
    const inner = note({ id: 'orig', text: 'original' });
    const p = mapNote(note({ id: 'rn', text: null, channel: chX, renote: inner }));
    expect(p.channel).toEqual(chX);
  });

  it('引用（外側 X・引用先 Y）→ 外側 X かつ quote.channel は Y', () => {
    const chY = { id: 'chY', name: '音楽部' };
    const quoted = note({ id: 'q1', text: 'quoted', channel: chY });
    const p = mapNote(note({ id: 'outer', text: 'comment', channel: chX, renote: quoted }));
    expect(p.channel).toEqual(chX);
    expect(p.quote?.channel).toEqual(chY);
  });
});

describe('localEmojiName（ADR-0006: リアクションキーの正規化）', () => {
  it.each([
    [':kawaii:', 'kawaii'],
    [':kawaii@.:', 'kawaii'],
    [':kawaii@other.host:', null],
    ['👍', null],
    ['::', null],
  ])('%s → %s', (key, expected) => {
    expect(localEmojiName(key)).toBe(expected);
  });
});

describe('mapNote: ローカルカスタム絵文字のレジストリ解決（ADR-0006）', () => {
  const registry = { kawaii: 'https://e/local-kawaii.png' };

  it('ローカル reaction（reactionEmojis 未掲載）をレジストリで解決', () => {
    const p = mapNote(note({ reactions: { ':kawaii:': 3 } }), registry);
    expect(p.reactions).toEqual([{ emoji: ':kawaii:', count: 3, emojiUrl: 'https://e/local-kawaii.png' }]);
  });

  it('ローカル明示表記 :name@.: もレジストリで解決', () => {
    const p = mapNote(note({ reactions: { ':kawaii@.:': 1 } }), registry);
    expect(p.reactions?.[0].emojiUrl).toBe('https://e/local-kawaii.png');
  });

  it('リモート reaction は reactionEmojis を使い、レジストリの同名絵文字にはフォールバックしない', () => {
    const p = mapNote(
      note({
        reactions: { ':kawaii@other.host:': 2 },
        reactionEmojis: { 'kawaii@other.host': 'https://e/remote-kawaii.png' },
      }),
      registry,
    );
    expect(p.reactions?.[0].emojiUrl).toBe('https://e/remote-kawaii.png');
  });

  it('リモート reaction で reactionEmojis 未掲載でもレジストリ解決しない（テキスト縮退）', () => {
    const p = mapNote(note({ reactions: { ':kawaii@other.host:': 2 } }), registry);
    expect(p.reactions?.[0].emojiUrl).toBeUndefined();
  });

  it('レジストリに無いローカル reaction はテキスト縮退（emojiUrl 無し）', () => {
    const p = mapNote(note({ reactions: { ':unknown:': 1 } }), registry);
    expect(p.reactions?.[0].emojiUrl).toBeUndefined();
  });

  it('本文のローカルカスタム絵文字もレジストリで解決', () => {
    const p = mapNote(note({ text: 'yo :kawaii:' }), registry);
    expect(p.rich).toContainEqual({ type: 'emoji', name: 'kawaii', url: 'https://e/local-kawaii.png' });
  });

  it('ノート由来の emojis（リモート）はレジストリより優先', () => {
    const p = mapNote(
      note({ text: 'yo :kawaii:', emojis: [{ name: 'kawaii', url: 'https://e/note-kawaii.png' }] }),
      registry,
    );
    expect(p.rich).toContainEqual({ type: 'emoji', name: 'kawaii', url: 'https://e/note-kawaii.png' });
  });
});

function okResponse(emojis: { name: string; url: string }[]) {
  return new Response(JSON.stringify({ emojis }), { status: 200 });
}

describe('loadEmojiRegistry（ADR-0006: /api/emojis のキャッシュ）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('name → url マップを返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([{ name: 'a', url: 'https://e/a.png' }])));
    const map = await loadEmojiRegistry({ MISSKEY_INSTANCE_URL: 'https://reg-basic.test' });
    expect(map).toEqual({ a: 'https://e/a.png' });
  });

  it('TTL 内は再取得しない（キャッシュ）', async () => {
    const fetchMock = vi.fn(async () => okResponse([{ name: 'a', url: 'u' }]));
    vi.stubGlobal('fetch', fetchMock);
    const env = { MISSKEY_INSTANCE_URL: 'https://reg-cache.test' };
    await loadEmojiRegistry(env);
    await loadEmojiRegistry(env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('TTL（30分）経過後は再取得する', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => okResponse([{ name: 'a', url: 'u' }]));
    vi.stubGlobal('fetch', fetchMock);
    const env = { MISSKEY_INSTANCE_URL: 'https://reg-ttl.test' };
    await loadEmojiRegistry(env);
    vi.advanceTimersByTime(31 * 60 * 1000);
    await loadEmojiRegistry(env);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('並行呼び出しは1回の fetch に合流する（シングルフライト）', async () => {
    let resolveFetch!: (v: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => (resolveFetch = r)));
    vi.stubGlobal('fetch', fetchMock);
    const env = { MISSKEY_INSTANCE_URL: 'https://reg-flight.test' };
    const p1 = loadEmojiRegistry(env);
    const p2 = loadEmojiRegistry(env);
    resolveFetch(okResponse([{ name: 'a', url: 'u' }]));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ a: 'u' });
    expect(r2).toEqual({ a: 'u' });
  });

  it('異なるインスタンスへの並行呼び出しはインスタンスごとに1回ずつ fetch する', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://reg-multi-a.test')) return okResponse([{ name: 'a', url: 'https://e/a.png' }]);
      return okResponse([{ name: 'b', url: 'https://e/b.png' }]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const [rA, rB] = await Promise.all([
      loadEmojiRegistry({ MISSKEY_INSTANCE_URL: 'https://reg-multi-a.test' }),
      loadEmojiRegistry({ MISSKEY_INSTANCE_URL: 'https://reg-multi-b.test' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rA).toEqual({ a: 'https://e/a.png' });
    expect(rB).toEqual({ b: 'https://e/b.png' });
  });

  it('取得失敗は空マップに縮退し、キャッシュしない（次回リトライ）', async () => {
    const fetchMock = vi.fn(async () => new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { MISSKEY_INSTANCE_URL: 'https://reg-fail.test' };
    expect(await loadEmojiRegistry(env)).toEqual({});
    fetchMock.mockImplementation(async () => okResponse([{ name: 'a', url: 'u' }]));
    expect(await loadEmojiRegistry(env)).toEqual({ a: 'u' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('getEmojiList（ピッカー配信: compact 化）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('name/url/aliases の compact な一覧を返す（空 aliases は省略）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            emojis: [
              { name: 'a', url: 'https://e/a.png', aliases: ['ay', 'ei'], category: 'x', host: null },
              { name: 'b', url: 'https://e/b.png', aliases: [], category: 'y', host: null },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const list = await getEmojiList({ MISSKEY_INSTANCE_URL: 'https://emojilist.test' });
    expect(list).toEqual([
      { name: 'a', url: 'https://e/a.png', aliases: ['ay', 'ei'] },
      { name: 'b', url: 'https://e/b.png' },
    ]);
  });

  it('loadEmojiRegistry と同じキャッシュを共有する（追加 fetch なし）', async () => {
    const fetchMock = vi.fn(async () => okResponse([{ name: 'a', url: 'u' }]));
    vi.stubGlobal('fetch', fetchMock);
    const env = { MISSKEY_INSTANCE_URL: 'https://emojishared.test' };
    await loadEmojiRegistry(env);
    const list = await getEmojiList(env);
    expect(list).toEqual([{ name: 'a', url: 'u' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function captureFetch(res: Response) {
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => res);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('react（リアクション操作）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const env = { MISSKEY_INSTANCE_URL: 'https://react.test', MISSKEY_TOKEN: 'tok' };

  it('reaction あり → notes/reactions/create（noteId/reaction を送信）', async () => {
    const fetchMock = captureFetch(new Response(null, { status: 204 }));
    await react(env, 'n1', ':kawaii:');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://react.test/api/notes/reactions/create',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ i: 'tok', noteId: 'n1', reaction: ':kawaii:' });
  });

  it('reaction なし → notes/reactions/delete', async () => {
    const fetchMock = captureFetch(new Response(null, { status: 204 }));
    await react(env, 'n1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://react.test/api/notes/reactions/delete',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ i: 'tok', noteId: 'n1' });
  });

  it('業務エラー → MisskeyApiError(409) に Misskey の code を載せる', async () => {
    captureFetch(
      new Response(JSON.stringify({ error: { code: 'ALREADY_REACTED', message: 'x', id: '51c42bb4' } }), { status: 400 }),
    );
    await expect(react(env, 'n1', '👍')).rejects.toMatchObject({ status: 409, code: 'ALREADY_REACTED' });
  });

  it('code 無しの失敗（5xx 等）→ 素の Error（MisskeyApiError にしない、run() が 502 化）', async () => {
    captureFetch(new Response('internal error', { status: 500 }));
    const err = await react(env, 'n1', '👍').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MisskeyApiError);
  });

  it('認証エラー（401/403）→ status=401 に正規化（MisskeyApiError ではない）', async () => {
    captureFetch(new Response('no', { status: 403 }));
    await expect(react(env, 'n1', '👍')).rejects.toMatchObject({ status: 401 });
    await expect(react(env, 'n1', '👍')).rejects.not.toBeInstanceOf(MisskeyApiError);
  });

  it('トークン無し → MisskeyAuthError', async () => {
    await expect(react({ MISSKEY_INSTANCE_URL: 'https://react.test' }, 'n1', '👍')).rejects.toBeInstanceOf(
      MisskeyAuthError,
    );
  });
});

/** URL でエンドポイントを振り分ける fetch モック（timeline 系 + emojis レジストリ） */
function stubMisskeyFetch(calls: { url: string; body: Record<string, unknown> }[]) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.body) calls.push({ url, body: JSON.parse(String(init.body)) });
    if (url.endsWith('/api/emojis')) return new Response(JSON.stringify({ emojis: [] }), { status: 200 });
    return new Response(JSON.stringify([note()]), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('getTimeline（Source 種別 dispatch）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('kind=home → notes/timeline', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    stubMisskeyFetch(calls);
    const res = await getTimeline({ MISSKEY_INSTANCE_URL: 'https://tl-home.test', MISSKEY_TOKEN: 't' }, { provider: 'misskey', kind: 'home' });
    expect(res.posts).toHaveLength(1);
    expect(res.nextCursor).toBe('n1');
    expect(calls.some((c) => c.url.endsWith('/api/notes/timeline'))).toBe(true);
  });

  it('kind=list → notes/user-list-timeline（listId + untilId）', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    stubMisskeyFetch(calls);
    await getTimeline(
      { MISSKEY_INSTANCE_URL: 'https://tl-list.test', MISSKEY_TOKEN: 't' },
      { provider: 'misskey', kind: 'list', id: 'L1' },
      'cur1',
    );
    const call = calls.find((c) => c.url.endsWith('/api/notes/user-list-timeline'));
    expect(call?.body).toMatchObject({ listId: 'L1', untilId: 'cur1', limit: 30 });
  });

  it('kind=antenna → antennas/notes（antennaId）', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    stubMisskeyFetch(calls);
    await getTimeline({ MISSKEY_INSTANCE_URL: 'https://tl-ant.test', MISSKEY_TOKEN: 't' }, { provider: 'misskey', kind: 'antenna', id: 'A1' });
    const call = calls.find((c) => c.url.endsWith('/api/antennas/notes'));
    expect(call?.body).toMatchObject({ antennaId: 'A1' });
  });

  it('kind=channel → channels/timeline（channelId + untilId。docs/misskey-channel-source-spec.md）', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    stubMisskeyFetch(calls);
    await getTimeline(
      { MISSKEY_INSTANCE_URL: 'https://tl-ch.test', MISSKEY_TOKEN: 't' },
      { provider: 'misskey', kind: 'channel', id: 'C1' },
      'cur1',
    );
    const call = calls.find((c) => c.url.endsWith('/api/channels/timeline'));
    expect(call?.body).toMatchObject({ channelId: 'C1', untilId: 'cur1', limit: 30 });
  });

  it('kind=list で id 無し → MisskeyApiError(400)', async () => {
    stubMisskeyFetch([]);
    await expect(
      getTimeline({ MISSKEY_INSTANCE_URL: 'https://tl-noid.test', MISSKEY_TOKEN: 't' }, { provider: 'misskey', kind: 'list' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('kind=channel で id 無し → MisskeyApiError(400)', async () => {
    stubMisskeyFetch([]);
    await expect(
      getTimeline({ MISSKEY_INSTANCE_URL: 'https://tl-chnoid.test', MISSKEY_TOKEN: 't' }, { provider: 'misskey', kind: 'channel' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('renote（docs/deck-view-spec.md §6）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('notes/create に renoteId を送る', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ createdNote: note() }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renote({ MISSKEY_INSTANCE_URL: 'https://renote.test', MISSKEY_TOKEN: 't' }, 'n9');
    const call = calls.find((c) => c.url.endsWith('/api/notes/create'));
    expect(call?.body).toMatchObject({ renoteId: 'n9', visibility: 'public' });
  });
});

describe('listSources（ピッカーカタログ）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ホーム + リスト + アンテナ + お気に入りチャンネル（📺 プレフィックス）を返す', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      if (url.endsWith('/api/users/lists/list')) {
        return new Response(JSON.stringify([{ id: 'L1', name: '技術' }]), { status: 200 });
      }
      if (url.endsWith('/api/antennas/list')) {
        return new Response(JSON.stringify([{ id: 'A1', name: 'AI' }]), { status: 200 });
      }
      if (url.endsWith('/api/channels/my-favorites')) {
        return new Response(JSON.stringify([{ id: 'C1', name: 'ゲーム部' }]), { status: 200 });
      }
      return new Response('null', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const options = await listSources({ MISSKEY_INSTANCE_URL: 'https://src.test', MISSKEY_TOKEN: 't' });
    expect(options).toEqual([
      { source: { provider: 'misskey', kind: 'home' }, name: 'ホーム' },
      { source: { provider: 'misskey', kind: 'list', id: 'L1' }, name: '技術' },
      { source: { provider: 'misskey', kind: 'antenna', id: 'A1' }, name: 'AI' },
      { source: { provider: 'misskey', kind: 'channel', id: 'C1' }, name: '📺 ゲーム部' },
    ]);
    // お気に入りは limit: 100 の1ページ分のみ（docs/misskey-channel-source-spec.md）
    const fav = calls.find((c) => c.url.endsWith('/api/channels/my-favorites'));
    expect(fav?.body).toMatchObject({ limit: 100 });
  });
});

describe('listDestinations（投稿先カタログ。docs/compose-destination-spec.md §4.1）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ホーム + フォロー中∪お気に入りチャンネル（id 重複排除・📺 プレフィックス）を返す', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      if (url.endsWith('/api/channels/followed')) {
        return new Response(JSON.stringify([{ id: 'C1', name: 'ゲーム部' }, { id: 'C2', name: '技術部' }]), { status: 200 });
      }
      if (url.endsWith('/api/channels/my-favorites')) {
        // C2 はフォロー中と重複 → 排除される
        return new Response(JSON.stringify([{ id: 'C2', name: '技術部' }, { id: 'C3', name: '音楽部' }]), { status: 200 });
      }
      return new Response('null', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const options = await listDestinations({ MISSKEY_INSTANCE_URL: 'https://dest.test', MISSKEY_TOKEN: 't' });
    expect(options).toEqual([
      { destination: { provider: 'misskey', kind: 'home' }, name: 'ホーム' },
      { destination: { provider: 'misskey', kind: 'channel', id: 'C1' }, name: '📺 ゲーム部' },
      { destination: { provider: 'misskey', kind: 'channel', id: 'C2' }, name: '📺 技術部' },
      { destination: { provider: 'misskey', kind: 'channel', id: 'C3' }, name: '📺 音楽部' },
    ]);
    const followed = calls.find((c) => c.url.endsWith('/api/channels/followed'));
    expect(followed?.body).toMatchObject({ limit: 100 });
  });
});

describe('createPost（Destination 受け渡し。docs/compose-destination-spec.md §4.2）', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubCreate(calls: { url: string; body: Record<string, unknown> }[]) {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ createdNote: note() }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('destination=channel → notes/create に channelId を送る', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    stubCreate(calls);
    await createPost(
      { MISSKEY_INSTANCE_URL: 'https://post.test', MISSKEY_TOKEN: 't' },
      { provider: 'misskey', text: 'hi', destination: { provider: 'misskey', kind: 'channel', id: 'C1' } },
    );
    const call = calls.find((c) => c.url.endsWith('/api/notes/create'));
    expect(call?.body).toMatchObject({ text: 'hi', channelId: 'C1' });
  });

  it('destination=home / 省略 → channelId を送らない', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    stubCreate(calls);
    await createPost(
      { MISSKEY_INSTANCE_URL: 'https://post.test', MISSKEY_TOKEN: 't' },
      { provider: 'misskey', text: 'hi', destination: { provider: 'misskey', kind: 'home' } },
    );
    const call = calls.find((c) => c.url.endsWith('/api/notes/create'));
    expect(call?.body).not.toHaveProperty('channelId');
  });
});

describe('nameToRich（表示名の絵文字解決。docs/name-display-spec.md §4）', () => {
  it('解決できるショートコードを絵文字セグメント化する', () => {
    const rich = nameToRich('応彩しずく :verified_blue:', { verified_blue: 'https://e/vb.png' });
    expect(rich).toEqual([
      { type: 'text', text: '応彩しずく ' },
      { type: 'emoji', name: 'verified_blue', url: 'https://e/vb.png' },
    ]);
  });

  it('未収録ショートコードは生テキストのまま', () => {
    const rich = nameToRich('a :unknown: b', { known: 'u' });
    expect(rich).toBeUndefined();
  });

  it('解決・未収録が混在すると、未収録はテキストとして残る', () => {
    const rich = nameToRich(':known: x :unknown:', { known: 'u1' });
    expect(rich).toEqual([
      { type: 'emoji', name: 'known', url: 'u1' },
      { type: 'text', text: ' x :unknown:' },
    ]);
  });

  it('コロン無し → undefined', () => {
    expect(nameToRich('ただの名前', { a: 'u' })).toBeUndefined();
  });

  it('mapNote: 投稿者名と repostedBy に反映される', () => {
    // 通常ノート: author に反映
    const p1 = mapNote(note({ user: user({ name: 'shizuku :verified_blue:' }) }), { verified_blue: 'https://e/vb.png' });
    expect(p1.author.displayNameRich?.[1]).toEqual({ type: 'emoji', name: 'verified_blue', url: 'https://e/vb.png' });
    // 純粋renote: 表示主体は内側ノートの著者、renote した人（外側）は repostedBy に入り同様に解決される
    const n = note({
      user: user({ name: 'carol :verified_blue:' }),
      renote: note({ id: 'inner', text: 'body' }),
      text: null,
    });
    const p2 = mapNote(n, { verified_blue: 'https://e/vb.png' });
    expect(p2.repostedBy?.displayNameRich?.[1]).toEqual({ type: 'emoji', name: 'verified_blue', url: 'https://e/vb.png' });
  });
});
