import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  blockUser,
  isHiddenPost,
  isOwnPost,
  muteUser,
  resetModerationForTests,
  subscribeHidden,
  subscribeModerationToasts,
} from './moderation';
import type { Post } from '../../../shared/types';

vi.mock('../api', () => ({
  api: {
    me: vi.fn(),
    mute: vi.fn(),
    unmute: vi.fn(),
    block: vi.fn(),
    unblock: vi.fn(),
  },
}));

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    provider: 'bluesky',
    author: { id: 'did:plc:alice', handle: 'alice.bsky.social', displayName: 'Alice' },
    text: 'hi',
    createdAt: '2026-07-01T12:00:00Z',
    media: [],
    stats: { replies: 0, reposts: 0, likes: 0 },
    source: {},
    ...overrides,
  };
}

beforeEach(() => {
  resetModerationForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  resetModerationForTests();
});

describe('muteUser（docs/block-mute-spec.md §5.2 / §5.3）', () => {
  it('成功 → 非表示セットへ追加し、取り消し付きトーストを発火する', async () => {
    vi.mocked(api.mute).mockResolvedValue({});
    const post = makePost();
    const hidden: boolean[] = [];
    subscribeHidden(() => hidden.push(isHiddenPost(post)));
    const toasts: { message: string; undo?: () => void }[] = [];
    subscribeModerationToasts((t) => toasts.push(t));

    muteUser(post);
    await vi.waitFor(() => expect(api.mute).toHaveBeenCalledWith('bluesky', 'did:plc:alice'));

    expect(isHiddenPost(post)).toBe(true);
    expect(hidden).toEqual([true]);
    expect(toasts[0].message).toBe('@alice.bsky.social をミュートしました');
    expect(toasts[0].undo).toBeTypeOf('function');

    // 取り消し → unmute を呼び、非表示解除、取り消しトースト
    toasts[0].undo?.();
    await vi.waitFor(() => expect(api.unmute).toHaveBeenCalledWith('bluesky', 'did:plc:alice'));
    expect(isHiddenPost(post)).toBe(false);
    expect(toasts[1].message).toBe('@alice.bsky.social のミュートを取り消しました');
  });

  it('失敗 → 非表示にせずエラートーストのみ', async () => {
    vi.mocked(api.mute).mockRejectedValue(new Error('boom'));
    const post = makePost();
    const toasts: { message: string; undo?: () => void }[] = [];
    subscribeModerationToasts((t) => toasts.push(t));

    muteUser(post);
    await vi.waitFor(() => expect(toasts.length).toBe(1));

    expect(isHiddenPost(post)).toBe(false);
    expect(toasts[0].message).toBe('ミュートに失敗しました');
    expect(toasts[0].undo).toBeUndefined();
  });

  it('nostr（読み取り専用）は no-op', () => {
    muteUser(makePost({ provider: 'nostr' }));
    expect(api.mute).not.toHaveBeenCalled();
  });
});

describe('blockUser', () => {
  it('成功 → 非表示セットへ追加し、取り消し付きトーストを発火する', async () => {
    vi.mocked(api.block).mockResolvedValue({});
    const post = makePost({ provider: 'misskey', author: { id: 'u-alice', handle: 'alice', displayName: 'Alice' } });
    const toasts: { message: string; undo?: () => void }[] = [];
    subscribeModerationToasts((t) => toasts.push(t));

    blockUser(post);
    await vi.waitFor(() => expect(api.block).toHaveBeenCalledWith('misskey', 'u-alice'));

    expect(isHiddenPost(post)).toBe(true);
    expect(toasts[0].message).toBe('@alice をブロックしました');

    toasts[0].undo?.();
    await vi.waitFor(() => expect(api.unblock).toHaveBeenCalledWith('misskey', 'u-alice'));
    expect(isHiddenPost(post)).toBe(false);
  });
});

describe('isOwnPost（§5.1: 自分の投稿では項目非表示）', () => {
  it('自分の actorId と一致すれば true', async () => {
    vi.mocked(api.me).mockResolvedValue({
      me: { bluesky: { actorId: 'did:plc:alice' }, misskey: null },
    });
    await expect(isOwnPost(makePost())).resolves.toBe(true);
    await expect(isOwnPost(makePost({ author: { id: 'did:plc:bob', handle: 'b', displayName: 'B' } }))).resolves.toBe(false);
  });

  it('/api/me は1回だけ呼ぶ（キャッシュ）', async () => {
    vi.mocked(api.me).mockResolvedValue({ me: { bluesky: { actorId: 'did:plc:alice' }, misskey: null } });
    await isOwnPost(makePost());
    await isOwnPost(makePost());
    expect(api.me).toHaveBeenCalledTimes(1);
  });

  it('loadMe 失敗後は再試行できる（失敗の null をキャッシュしない）', async () => {
    vi.mocked(api.me)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ me: { bluesky: { actorId: 'did:plc:alice' }, misskey: null } });
    await expect(isOwnPost(makePost())).resolves.toBe(false); // 1回目: 失敗
    await expect(isOwnPost(makePost())).resolves.toBe(true); // 2回目: 再試行が成功
    expect(api.me).toHaveBeenCalledTimes(2);
  });
});

describe('mute と block の共存（docs/block-mute-spec.md §5.3）', () => {
  it('両方適用後に片方だけ取り消しても、もう片方の非表示は維持される', async () => {
    vi.mocked(api.mute).mockResolvedValue({});
    vi.mocked(api.block).mockResolvedValue({});
    vi.mocked(api.unmute).mockResolvedValue({});
    vi.mocked(api.unblock).mockResolvedValue({});
    const post = makePost();
    const toasts: { message: string; undo?: () => void }[] = [];
    subscribeModerationToasts((t) => toasts.push(t));

    muteUser(post);
    await vi.waitFor(() => expect(api.mute).toHaveBeenCalled());
    blockUser(post);
    await vi.waitFor(() => expect(api.block).toHaveBeenCalled());
    expect(isHiddenPost(post)).toBe(true);

    // ミュートの取り消し → ブロックによる非表示は残る
    toasts.find((t) => t.message.includes('ミュートしました'))?.undo?.();
    await vi.waitFor(() => expect(api.unmute).toHaveBeenCalled());
    expect(isHiddenPost(post)).toBe(true);

    // ブロックの取り消し → 完全に非表示解除
    toasts.find((t) => t.message.includes('ブロックしました'))?.undo?.();
    await vi.waitFor(() => expect(api.unblock).toHaveBeenCalled());
    expect(isHiddenPost(post)).toBe(false);
  });

  it('実行中の同一操作は二重送信しない（in-flight ガード）', async () => {
    let resolveMute!: (v: Record<string, never>) => void;
    vi.mocked(api.mute).mockImplementation(() => new Promise((r) => (resolveMute = r)));
    const post = makePost();
    muteUser(post);
    muteUser(post); // 実行中の重複呼び出しは無視される
    expect(api.mute).toHaveBeenCalledTimes(1);
    resolveMute({});
    await vi.waitFor(() => expect(isHiddenPost(post)).toBe(true));
  });
});
