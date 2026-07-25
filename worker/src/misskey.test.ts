// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mapNote, mfmToRich } from './misskey';

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
