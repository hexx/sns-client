import { describe, expect, it } from 'vitest';
import { withLike, withRenoteIncrement, withRepost } from './engagements';
import type { Post } from '../../../shared/types';

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    provider: 'bluesky',
    author: { id: 'u-a', handle: 'a', displayName: 'A' },
    text: 'x',
    createdAt: '2026-07-01T12:00:00Z',
    media: [],
    stats: { replies: 0, reposts: 2, likes: 3 },
    source: {},
    ...overrides,
  };
}

describe('withLike', () => {
  it('未 Like → カウント+1 と likeUri を設定', () => {
    const p = withLike(makePost(), true, 'at://like/1');
    expect(p.stats.likes).toBe(4);
    expect(p.viewer?.likeUri).toBe('at://like/1');
  });

  it('Like 済み → 解除でカウント-1 と likeUri 消去', () => {
    const p = withLike(makePost({ viewer: { likeUri: 'at://like/1' } }), false);
    expect(p.stats.likes).toBe(2);
    expect(p.viewer?.likeUri).toBeUndefined();
  });

  it('同じ状態なら何もしない（冪等）', () => {
    const orig = makePost();
    expect(withLike(orig, false)).toBe(orig);
  });

  it('カウントは 0 未満にならない', () => {
    const p = withLike(makePost({ stats: { replies: 0, reposts: 0, likes: 0 }, viewer: { likeUri: 'x' } }), false);
    expect(p.stats.likes).toBe(0);
  });
});

describe('withRepost', () => {
  it('トグルでカウントと repostUri が切り替わる', () => {
    const on = withRepost(makePost(), true, 'at://repost/1');
    expect(on.stats.reposts).toBe(3);
    expect(on.viewer?.repostUri).toBe('at://repost/1');
    const off = withRepost(on, false);
    expect(off.stats.reposts).toBe(2);
    expect(off.viewer?.repostUri).toBeUndefined();
  });
});

describe('withRenoteIncrement', () => {
  it('リポスト数を 1 増やす（viewer は触らない）', () => {
    const p = withRenoteIncrement(makePost());
    expect(p.stats.reposts).toBe(3);
    expect(p.viewer).toBeUndefined();
  });
});
