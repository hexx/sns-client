import { describe, expect, it } from 'vitest';
import { applyReaction } from './reactions';
import type { Post } from '../../../shared/types';

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'n1',
    provider: 'misskey',
    author: { id: 'u-alice', handle: 'alice', displayName: 'Alice' },
    text: 'hi',
    createdAt: '2026-07-01T12:00:00Z',
    media: [],
    stats: { replies: 0, reposts: 0, likes: 0 },
    ref: 'n1',
    source: {},
    ...overrides,
  };
}

describe('applyReaction（楽観パッチ）', () => {
  it('無反応 → 付与（新規チップ、likes +1）', () => {
    const p = applyReaction(makePost(), '👍');
    expect(p.reactions).toEqual([{ emoji: '👍', count: 1, me: true }]);
    expect(p.stats.likes).toBe(1);
  });

  it('カスタム絵文字の付与は emojiUrl を保持する', () => {
    const p = applyReaction(makePost(), ':kawaii:', 'https://e/kawaii.png');
    expect(p.reactions).toEqual([{ emoji: ':kawaii:', count: 1, me: true, emojiUrl: 'https://e/kawaii.png' }]);
  });

  it('他人の反応に相乗り（count +1・me 付与、likes +1）', () => {
    const post = makePost({
      reactions: [{ emoji: '👍', count: 2 }],
      stats: { replies: 0, reposts: 0, likes: 2 },
    });
    const p = applyReaction(post, '👍');
    expect(p.reactions).toEqual([{ emoji: '👍', count: 3, me: true }]);
    expect(p.stats.likes).toBe(3);
  });

  it('自分の反応を解除（count 1 → チップ消滅、likes -1）', () => {
    const post = makePost({
      reactions: [{ emoji: '👍', count: 1, me: true }],
      stats: { replies: 0, reposts: 0, likes: 1 },
    });
    const p = applyReaction(post);
    expect(p.reactions).toEqual([]);
    expect(p.stats.likes).toBe(0);
  });

  it('自分の反応を解除（count >1 → count のみ減、me 消滅）', () => {
    const post = makePost({
      reactions: [{ emoji: '👍', count: 3, me: true }],
      stats: { replies: 0, reposts: 0, likes: 3 },
    });
    const p = applyReaction(post);
    expect(p.reactions).toEqual([{ emoji: '👍', count: 2, me: false }]);
    expect(p.stats.likes).toBe(2);
  });

  it('別絵文字へ置換（旧 -1・新 +1、likes は不変）', () => {
    const post = makePost({
      reactions: [
        { emoji: '👍', count: 1, me: true },
        { emoji: '🎉', count: 4 },
      ],
      stats: { replies: 0, reposts: 0, likes: 5 },
    });
    const p = applyReaction(post, '🎉');
    expect(p.reactions).toContainEqual({ emoji: '🎉', count: 5, me: true });
    expect(p.reactions).not.toContainEqual(expect.objectContaining({ emoji: '👍' }));
    expect(p.stats.likes).toBe(5);
  });

  it('無反応の解除は何もしない', () => {
    const post = makePost();
    const p = applyReaction(post);
    expect(p.reactions).toEqual([]);
    expect(p.stats.likes).toBe(0);
  });

  it('入力 Post を破壊しない（不変）', () => {
    const post = makePost({ reactions: [{ emoji: '👍', count: 1, me: true }] });
    applyReaction(post);
    expect(post.reactions).toEqual([{ emoji: '👍', count: 1, me: true }]);
  });
});
