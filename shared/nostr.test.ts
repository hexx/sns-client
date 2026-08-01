// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32 } from '@scure/base';
import {
  NOSTR_RELAYS,
  resetProfileCache,
  decodeNpub,
  getThread,
  getTimeline,
  parentEventId,
  parseProfile,
  queryRelays,
  shortenNpub,
  toSegments,
  verifyEvent,
  type NostrEvent,
  type NostrFilter,
  type WsFactory,
  type WsLike,
} from './nostr';

beforeEach(() => {
  resetProfileCache();
});

// --- テスト用 hex helpers ---
function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const PRIV = fromHex('11'.repeat(32));
const PUB = toHex(schnorr.getPublicKey(PRIV));
const PRIV2 = fromHex('22'.repeat(32));
const PUB2 = toHex(schnorr.getPublicKey(PRIV2));

/** 正しく署名されたイベントを生成する */
function makeEvent(opts: {
  priv?: Uint8Array;
  kind?: number;
  content?: string;
  tags?: string[][];
  created_at?: number;
}): NostrEvent {
  const priv = opts.priv ?? PRIV;
  const pubkey = toHex(schnorr.getPublicKey(priv));
  const kind = opts.kind ?? 1;
  const content = opts.content ?? '';
  const tags = opts.tags ?? [];
  const created_at = opts.created_at ?? 1000;
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const id = toHex(sha256(new TextEncoder().encode(serialized)));
  const sig = toHex(schnorr.sign(fromHex(id), priv));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

function npubOf(hex: string): string {
  return bech32.encode('npub', bech32.toWords(fromHex(hex)), 5000);
}

function matches(ev: NostrEvent, f: NostrFilter): boolean {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.until !== undefined && ev.created_at > f.until) return false;
  return true;
}

/** フィルタを考慮するフェークリレー（EOSE 付き）。url ごとにイベント集合を持つ */
function fakeRelay(eventsByUrl: Record<string, NostrEvent[]>): WsFactory {
  return async (url: string): Promise<WsLike> => {
    let onMessage: ((ev: { data?: unknown }) => void) | undefined;
    return {
      send(data: string) {
        const req = JSON.parse(data) as [string, string, NostrFilter];
        const filter = req[2] ?? {};
        let matched = (eventsByUrl[url] ?? []).filter((e) => matches(e, filter));
        if (filter.limit) matched = matched.slice(0, filter.limit);
        queueMicrotask(() => {
          for (const e of matched) onMessage?.({ data: JSON.stringify(['EVENT', 'sns', e]) });
          onMessage?.({ data: JSON.stringify(['EOSE', 'sns']) });
        });
      },
      close() {},
      addEventListener(type, listener) {
        if (type === 'message') onMessage = listener;
      },
    };
  };
}

/** 何も応答しないリレー（タイムアウト検証用） */
const silentRelay: WsFactory = async () => ({
  send() {},
  close() {},
  addEventListener() {},
});

/** 接続失敗するリレー（ネットワーク制限・リレーダウンの模倣） */
const blockedRelay: WsFactory = async () => {
  throw new Error('blocked');
};

/** 全固定リレーに同じイベント集合を配置する（pubkey Source 用） */
function onAllRelays(events: NostrEvent[]): Record<string, NostrEvent[]> {
  const m: Record<string, NostrEvent[]> = {};
  for (const url of NOSTR_RELAYS) m[url] = events;
  return m;
}

describe('bech32 / 短縮表示', () => {
  it('decodeNpub は npub を hex pubkey に復元する', () => {
    expect(decodeNpub(npubOf(PUB))).toBe(PUB);
  });
  it('decodeNpub は npub 以外を拒否する', () => {
    const note = bech32.encode('note', bech32.toWords(fromHex('ab'.repeat(32))), 5000);
    expect(() => decodeNpub(note)).toThrow();
  });
  it('shortenNpub は npub 短縮形を返す', () => {
    const s = shortenNpub(PUB);
    expect(s.startsWith('npub1')).toBe(true);
    expect(s).toContain('…');
  });
});

describe('verifyEvent', () => {
  it('正当なイベントは true', () => {
    expect(verifyEvent(makeEvent({ content: 'hello' }))).toBe(true);
  });
  it('content 改ざん（id 不一致）は false', () => {
    const ev = makeEvent({ content: 'hello' });
    expect(verifyEvent({ ...ev, content: 'tampered' })).toBe(false);
  });
  it('署名破損は false', () => {
    const ev = makeEvent({ content: 'hello' });
    expect(verifyEvent({ ...ev, sig: '00'.repeat(64) })).toBe(false);
  });
  it('id が非 hex は false', () => {
    const ev = makeEvent({});
    expect(verifyEvent({ ...ev, id: 'zz' })).toBe(false);
  });
});

describe('toSegments', () => {
  it('プレーンテキスト', () => {
    const r = toSegments('just hello');
    expect(r.text).toBe('just hello');
    expect(r.rich).toEqual([{ type: 'text', text: 'just hello' }]);
    expect(r.media).toEqual([]);
  });
  it('URL は link、画像 URL は media にリフト（本文から除去）', () => {
    const r = toSegments('see https://example.com/a.jpg and https://example.com/');
    expect(r.media).toEqual([{ type: 'image', url: 'https://example.com/a.jpg' }]);
    expect(r.rich.some((s) => s.type === 'link' && s.url === 'https://example.com/')).toBe(true);
    expect(r.text).not.toContain('a.jpg');
    expect(r.text).toContain('https://example.com/');
  });
  it('nostr:npub メンションは mention（短縮 handle）', () => {
    const npub = npubOf(PUB);
    const r = toSegments(`hi nostr:${npub} !`);
    const mention = r.rich.find((s) => s.type === 'mention');
    expect(mention).toBeDefined();
    expect((mention as { handle: string }).handle.startsWith('npub1')).toBe(true);
  });
  it('ハッシュタグは hashtag（# を除く）', () => {
    const r = toSegments('hello #nostr world');
    expect(r.rich).toContainEqual({ type: 'hashtag', tag: 'nostr' });
  });
  it('URL 末尾の句読点はリンクから剥がして本文へ戻す', () => {
    const r = toSegments('see https://example.com/a. ok');
    const linkIdx = r.rich.findIndex((s) => s.type === 'link');
    expect((r.rich[linkIdx] as { url: string }).url).toBe('https://example.com/a'); // リンクは句読点不含
    expect(r.rich[linkIdx + 1]).toEqual({ type: 'text', text: '. ok' }); // 剥がした句読点はテキストで戻る
  });
  it('URL のバランスの取れた括弧は剥がさない（Wikipedia 風）', () => {
    const r = toSegments('https://en.wikipedia.org/wiki/Foo_(bar)');
    const link = r.rich.find((s) => s.type === 'link') as { url: string };
    expect(link.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });
  it('URL を囲む閉じ括弧は剥がす', () => {
    const r = toSegments('(https://example.com/x)');
    const link = r.rich.find((s) => s.type === 'link') as { url: string };
    expect(link.url).toBe('https://example.com/x');
    expect(r.text).toContain(')');
  });
  it('画像 URL の末尾句読点を剥がして media 判定する', () => {
    const r = toSegments('https://example.com/a.jpg.');
    expect(r.media).toEqual([{ type: 'image', url: 'https://example.com/a.jpg' }]);
  });
});

describe('parseProfile', () => {
  it('display_name / picture を抽出', () => {
    expect(parseProfile(JSON.stringify({ display_name: 'Alice', picture: 'https://x/a.png', name: 'a' }))).toEqual({
      displayName: 'Alice',
      picture: 'https://x/a.png',
    });
  });
  it('display_name 無しは name に縮退', () => {
    expect(parseProfile(JSON.stringify({ name: 'bob' })).displayName).toBe('bob');
  });
  it('不正 JSON は空', () => {
    expect(parseProfile('not json')).toEqual({});
    expect(parseProfile(undefined)).toEqual({});
  });
});

describe('queryRelays', () => {
  it('複数リレーの同一イベントを id で重複排除する', async () => {
    const ev = makeEvent({ content: 'dup' });
    const factory = fakeRelay(onAllRelays([ev]));
    const res = await queryRelays(NOSTR_RELAYS, { kinds: [1] }, { wsFactory: factory });
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe(ev.id);
  });

  it('不正署名イベントは破棄される', async () => {
    const good = makeEvent({ content: 'good' });
    const bad = { ...makeEvent({ content: 'bad' }), sig: '00'.repeat(64) };
    const factory = fakeRelay({ 'wss://r': [good, bad] });
    const res = await queryRelays(['wss://r'], { kinds: [1] }, { wsFactory: factory });
    expect(res.map((e) => e.id)).toEqual([good.id]);
  });

  it('到達不能リレーはスキップして他から収集する', async () => {
    const ev = makeEvent({});
    const factory: WsFactory = async (url) => {
      if (url === 'wss://dead') throw new Error('unreachable');
      return fakeRelay({ 'wss://alive': [ev] })(url);
    };
    const res = await queryRelays(['wss://dead', 'wss://alive'], { kinds: [1] }, { wsFactory: factory });
    expect(res).toHaveLength(1);
  });

  it('EOSE も応答もないリレーはタイムアウトで解決し、ハングしない', async () => {
    const res = await queryRelays(['wss://silent'], { kinds: [1] }, { wsFactory: silentRelay, timeoutMs: 30 });
    expect(res).toEqual([]);
  });
});

describe('getTimeline', () => {
  it('pubkey Source: kind1 を時系列降順で返し、kind0 で Author を解決する', async () => {
    const older = makeEvent({ content: 'older', created_at: 100 });
    const newer = makeEvent({ content: 'newer', created_at: 200 });
    const profile = makeEvent({ kind: 0, content: JSON.stringify({ display_name: 'Alice', picture: 'https://x/a.png' }), created_at: 50 });
    const factory = fakeRelay(onAllRelays([older, newer, profile]));
    const res = await getTimeline({ provider: 'nostr', kind: 'pubkey', id: npubOf(PUB) }, undefined, { wsFactory: factory });
    expect(res.posts.map((p) => p.text)).toEqual(['newer', 'older']);
    expect(res.posts[0].provider).toBe('nostr');
    expect(res.posts[0].author.displayName).toBe('Alice');
    expect(res.posts[0].author.avatarUrl).toBe('https://x/a.png');
    expect(res.posts[0].stats).toEqual({ replies: 0, reposts: 0, likes: 0 });
    expect(res.nextCursor).toBe('100'); // 最古の created_at
  });

  it('kind0 未取得時は handle（npub 短縮）に縮退する', async () => {
    const ev = makeEvent({ content: 'anon', created_at: 100 });
    const factory = fakeRelay(onAllRelays([ev])); // kind0 なし
    const res = await getTimeline({ provider: 'nostr', kind: 'pubkey', id: npubOf(PUB) }, undefined, { wsFactory: factory });
    expect(res.posts[0].author.displayName).toBe(res.posts[0].author.handle);
    expect(res.posts[0].author.handle.startsWith('npub1')).toBe(true);
    expect(res.posts[0].author.avatarUrl).toBeUndefined();
  });

  it('kind6 は元ノートを repostedBy で包む', async () => {
    const original = makeEvent({ priv: PRIV2, content: 'original', created_at: 100 });
    const repost = makeEvent({ kind: 6, tags: [['e', original.id]], created_at: 200 });
    const factory = fakeRelay(onAllRelays([original, repost]));
    const res = await getTimeline({ provider: 'nostr', kind: 'pubkey', id: npubOf(PUB) }, undefined, { wsFactory: factory });
    // kind1 フィルタに original は authors(PUB) 一致しないが、kind6 解決の ids 取得で拾われる
    const rp = res.posts.find((p) => p.repostedBy);
    expect(rp).toBeDefined();
    expect(rp!.text).toBe('original');
    expect(rp!.author.handle).toBe(shortenNpub(PUB2)); // 元ノートの著者
    expect(rp!.repostedBy!.handle).toBe(shortenNpub(PUB)); // リポストした人
  });

  it('参照先が取得できない kind6 はスキップする', async () => {
    const repost = makeEvent({ kind: 6, tags: [['e', 'ab'.repeat(32)]], created_at: 200 });
    const factory = fakeRelay(onAllRelays([repost])); // 元ノート無し
    const res = await getTimeline({ provider: 'nostr', kind: 'pubkey', id: npubOf(PUB) }, undefined, { wsFactory: factory });
    expect(res.posts).toHaveLength(0);
    expect(res.nextCursor).toBeNull();
  });

  it('relay Source: 指定リレー1本から kind1 のみ（kind6 は対象外）', async () => {
    const note = makeEvent({ content: 'local', created_at: 100 });
    const repost = makeEvent({ kind: 6, tags: [['e', 'cd'.repeat(32)]], created_at: 200 });
    const factory = fakeRelay({ 'wss://community.relay': [note, repost] });
    const res = await getTimeline({ provider: 'nostr', kind: 'relay', id: 'wss://community.relay' }, undefined, { wsFactory: factory });
    expect(res.posts).toHaveLength(1);
    expect(res.posts[0].text).toBe('local');
    expect(res.posts[0].repostedBy).toBeUndefined();
  });

  it('id 無し pubkey Source は throw', async () => {
    await expect(getTimeline({ provider: 'nostr', kind: 'pubkey' }, undefined, { wsFactory: fakeRelay({}) })).rejects.toThrow();
  });

  it('全リレー空でも空ページ（nextCursor null）で戻る', async () => {
    const res = await getTimeline({ provider: 'nostr', kind: 'pubkey', id: npubOf(PUB) }, undefined, { wsFactory: fakeRelay({}) });
    expect(res.posts).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });
});

describe('接続失敗の表出（docs/nostr-browser-direct-spec.md §6.5）', () => {
  it('relay Source: 接続失敗はネットワークヒント付きで throw', async () => {
    await expect(
      getTimeline({ provider: 'nostr', kind: 'relay', id: 'wss://blocked' }, undefined, { wsFactory: blockedRelay }),
    ).rejects.toThrow(/接続できません/);
  });

  it('relay Source: 接続成功・0件は空ページ（エラー非表示）', async () => {
    const res = await getTimeline(
      { provider: 'nostr', kind: 'relay', id: 'wss://empty' },
      undefined,
      { wsFactory: fakeRelay({ 'wss://empty': [] }) },
    );
    expect(res.posts).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });

  it('pubkey Source: 全リレー接続失敗は throw', async () => {
    await expect(
      getTimeline({ provider: 'nostr', kind: 'pubkey', id: npubOf(PUB) }, undefined, { wsFactory: blockedRelay }),
    ).rejects.toThrow(/接続できません/);
  });

  it('pubkey Source: 一部リレー不通でも他から取得して throw しない', async () => {
    const ev = makeEvent({ content: 'x', created_at: 100 });
    const factory: WsFactory = async (url) => {
      if (url === NOSTR_RELAYS[0]) throw new Error('dead');
      return fakeRelay(onAllRelays([ev]))(url);
    };
    const res = await getTimeline(
      { provider: 'nostr', kind: 'pubkey', id: npubOf(PUB) },
      undefined,
      { wsFactory: factory },
    );
    expect(res.posts.length).toBeGreaterThan(0);
  });
});

// --- スレッド解決（docs/thread-view-spec.md §5） ---

type TagFilter = NostrFilter & { '#e'?: string[] };

function matchesT(ev: NostrEvent, f: TagFilter): boolean {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f['#e']) {
    const eIds = new Set(ev.tags.filter((t) => t[0] === 'e').map((t) => t[1]));
    if (!f['#e'].some((id) => eIds.has(id))) return false;
  }
  return true;
}

const focusPostOf = (ev: NostrEvent) => ({ source: ev }) as never;

describe('parentEventId（NIP-10 の親解釈）', () => {
  const A = 'aa'.repeat(32);
  const B = 'bb'.repeat(32);

  it('marker reply を優先する', () => {
    const ev = makeEvent({ tags: [['e', A, '', 'root'], ['e', B, '', 'reply']] });
    expect(parentEventId(ev)).toBe(B);
  });

  it('e タグが1つだけ（root への直接返信）→ それが親', () => {
    const ev = makeEvent({ tags: [['e', A, '', 'root']] });
    expect(parentEventId(ev)).toBe(A);
  });

  it('無 marker 旧式は位置で解釈（最後が親）', () => {
    const ev = makeEvent({ tags: [['e', A], ['e', B]] });
    expect(parentEventId(ev)).toBe(B);
  });

  it('e タグ無し（トップレベル）→ undefined', () => {
    expect(parentEventId(makeEvent({ tags: [['p', A]] }))).toBeUndefined();
  });

  it('不正な id の e タグは無視する', () => {
    const ev = makeEvent({ tags: [['e', 'nothex'], ['e', A]] });
    expect(parentEventId(ev)).toBe(A);
  });
});

describe('getThread（ブラウザ直接解決）', () => {
  function threadRelay(events: NostrEvent[]): WsFactory {
    return async (): Promise<WsLike> => {
      let onMessage: ((ev: { data?: unknown }) => void) | undefined;
      return {
        send(data: string) {
          const filter = (JSON.parse(data) as [string, string, TagFilter])[2] ?? {};
          let matched = events.filter((e) => matchesT(e, filter));
          if (filter.limit) matched = matched.slice(0, filter.limit);
          queueMicrotask(() => {
            for (const e of matched) onMessage?.({ data: JSON.stringify(['EVENT', 'sns', e]) });
            onMessage?.({ data: JSON.stringify(['EOSE', 'sns']) });
          });
        },
        close() {},
        addEventListener(type, listener) {
          if (type === 'message') onMessage = listener;
        },
      };
    };
  }

  it('祖先を root 先頭で遡り、子孫を DFS＋depth で返す。欠落親は unavailable', async () => {
    const root = makeEvent({ content: 'root', created_at: 100 });
    const parent = makeEvent({ content: 'parent', created_at: 200, tags: [['e', root.id, '', 'root']] });
    const focus = makeEvent({ content: 'focus', created_at: 300, tags: [['e', parent.id, '', 'reply'], ['e', root.id, '', 'root']] });
    const c1 = makeEvent({ content: 'c1', created_at: 400, tags: [['e', focus.id, '', 'root']] });
    const c2 = makeEvent({ content: 'c2', created_at: 500, tags: [['e', root.id, '', 'root'], ['e', c1.id, '', 'reply']] });
    // 削除済み親への返信（root=focus を参照するが reply 先が取得不能）の現実シナリオ
    const orphan = makeEvent({
      content: 'orphan',
      created_at: 600,
      tags: [
        ['e', focus.id, '', 'root'],
        ['e', 'cc'.repeat(32), '', 'reply'],
      ],
    });
    const factory = threadRelay([root, parent, focus, c1, c2, orphan]);

    const res = await getThread(focusPostOf(focus), { wsFactory: factory });
    expect(res.focus.text).toBe('focus');
    expect(res.ancestors.map((p) => p.text)).toEqual(['root', 'parent']);
    expect(res.replies.map((n) => ({ text: n.post?.text, un: n.unavailable, depth: n.depth }))).toEqual([
      { text: 'c1', un: undefined, depth: 1 },
      { text: 'c2', un: undefined, depth: 2 },
      { text: undefined, un: true, depth: 1 },
      { text: 'orphan', un: undefined, depth: 2 },
    ]);
    expect(res.nextCursor).toBeNull();
  });

  it('親がリレーから得られない祖先はそこで打ち切る', async () => {
    const missing = 'dd'.repeat(32);
    const focus = makeEvent({ content: 'focus', tags: [['e', missing, '', 'reply']] });
    const factory = threadRelay([focus]);
    const res = await getThread(focusPostOf(focus), { wsFactory: factory });
    expect(res.ancestors).toEqual([]);
    expect(res.focus.text).toBe('focus');
  });

  it('source イベントが不正 → NostrError(400)', async () => {
    await expect(getThread({ source: { id: 'bad' } } as never, { wsFactory: threadRelay([]) })).rejects.toMatchObject({
      status: 400,
    });
  });
});
