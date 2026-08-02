import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadView } from './ThreadView';
import { fetchThread } from '../lib/thread';
import type { Post, ThreadNode, ThreadResponse } from '../../../shared/types';

vi.mock('../lib/thread', () => ({ fetchThread: vi.fn() }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      emojis: vi.fn().mockResolvedValue([]),
      react: vi.fn().mockResolvedValue({}),
      like: vi.fn().mockResolvedValue({ recordUri: 'at://l' }),
      unlike: vi.fn().mockResolvedValue({}),
      repost: vi.fn().mockResolvedValue({}),
      unrepost: vi.fn().mockResolvedValue({}),
    },
  };
});

// ブロック/ミュートの非表示判定（docs/block-mute-spec.md §5.4）を制御可能にする
const mod = vi.hoisted(() => ({ isHiddenPost: vi.fn((_p: Post) => false) }));
vi.mock('../lib/moderation', () => ({
  isHiddenPost: mod.isHiddenPost,
  subscribeHidden: () => () => {},
}));

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    provider: 'bluesky',
    author: { id: 'u-alice', handle: 'alice', displayName: 'Alice' },
    text: 'focus text',
    createdAt: '2026-07-01T12:00:00Z',
    media: [],
    stats: { replies: 0, reposts: 0, likes: 0 },
    ref: { uri: 'at://p1', cid: 'c1' },
    source: { uri: 'at://p1', cid: 'c1' },
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadResponse> = {}): ThreadResponse {
  return {
    focus: makePost(),
    ancestors: [],
    replies: [],
    nextCursor: null,
    ...overrides,
  };
}

const node = (post: Post, depth: number): ThreadNode => ({ post, depth });

beforeEach(() => {
  vi.clearAllMocks();
  mod.isHiddenPost.mockImplementation(() => false);
});

describe('ThreadView（docs/thread-view-spec.md §6）', () => {
  it('ancestors → focus（強調）→ replies の順で描画する', async () => {
    const root = makePost({ id: 'root', text: 'root text' });
    const parent = makePost({ id: 'parent', text: 'parent text' });
    const r1 = makePost({ id: 'r1', text: 'reply1 text' });
    vi.mocked(fetchThread).mockResolvedValue(
      makeThread({ focus: makePost({ id: 'focus', text: 'focus text' }), ancestors: [root, parent], replies: [node(r1, 1)] }),
    );
    const { container } = render(<ThreadView post={makePost({ id: 'focus' })} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('root text')).toBeInTheDocument());
    const nodes = [...container.querySelectorAll('.thread-node')];
    expect(nodes.map((n) => n.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('root text')]),
    );
    // 描画順: root → parent → focus → r1
    const texts = nodes.map((n) => n.textContent?.match(/(root|parent|focus|reply1) text/)?.[0]);
    expect(texts).toEqual(['root text', 'parent text', 'focus text', 'reply1 text']);
    // focus は強調ノード
    expect(container.querySelector('.thread-node-focus')?.textContent).toContain('focus text');
  });

  it('unavailable ノードはプレースホルダ行で描画する', async () => {
    vi.mocked(fetchThread).mockResolvedValue(
      makeThread({ replies: [{ unavailable: true, depth: 1 }] }),
    );
    render(<ThreadView post={makePost()} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('この投稿は取得できません')).toBeInTheDocument());
  });

  it('インデントは depth 5 で頭打ちになる', async () => {
    const deep = makePost({ id: 'deep', text: 'deep text' });
    vi.mocked(fetchThread).mockResolvedValue(makeThread({ replies: [node(deep, 9)] }));
    const { container } = render(<ThreadView post={makePost()} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('deep text')).toBeInTheDocument());
    const deepNode = [...container.querySelectorAll('.thread-node')].find((n) => n.textContent?.includes('deep text'));
    expect(deepNode).toHaveStyle({ paddingLeft: '80px' }); // min(9, 5) * 16
  });

  it('スレッド内の投稿クリックでフォーカスを置換して引き直す', async () => {
    const r1 = makePost({ id: 'r1', text: 'reply1 text' });
    vi.mocked(fetchThread).mockResolvedValue(makeThread({ replies: [node(r1, 1)] }));
    render(<ThreadView post={makePost()} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('reply1 text')).toBeInTheDocument());
    fireEvent.click(screen.getByText('reply1 text'));
    await waitFor(() => expect(fetchThread).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetchThread).mock.calls[1][0].id).toBe('r1');
  });

  it('quote card クリックで引用先のスレッドへ遷移する', async () => {
    const quoted = makePost({ id: 'q1', text: 'quoted text' });
    vi.mocked(fetchThread).mockResolvedValue(
      makeThread({ focus: makePost({ id: 'focus', quote: quoted }) }),
    );
    render(<ThreadView post={makePost({ id: 'focus' })} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('quoted text')).toBeInTheDocument());
    fireEvent.click(screen.getByText('quoted text'));
    await waitFor(() => expect(fetchThread).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetchThread).mock.calls[1][0].id).toBe('q1');
  });

  it('ブロック/ミュート済みユーザーのノードはプレースホルダ化する（docs/block-mute-spec.md §5.4）', async () => {
    const r1 = makePost({ id: 'r1', text: 'reply1 text' });
    const focus = makePost();
    vi.mocked(fetchThread).mockResolvedValue(makeThread({ focus, replies: [node(r1, 1)] }));
    mod.isHiddenPost.mockImplementation((p: Post) => p.id === 'r1');
    render(<ThreadView post={focus} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('focus text')).toBeInTheDocument());
    // 非表示ユーザーのノードは消え、取得不能プレースホルダに置き換わる（focus は残る）
    expect(screen.queryByText('reply1 text')).not.toBeInTheDocument();
    expect(screen.getAllByText('この投稿は取得できません')).toHaveLength(1);
  });

  it('フォーカス投稿の著者をブロック/ミュートするとフォーカスもプレースホルダ化する', async () => {
    const focus = makePost({ id: 'focus', text: 'focus text' });
    vi.mocked(fetchThread).mockResolvedValue(makeThread({ focus }));
    mod.isHiddenPost.mockImplementation((p: Post) => p.id === 'focus');
    render(<ThreadView post={focus} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('この投稿は取得できません')).toBeInTheDocument());
    expect(screen.queryByText('focus text')).not.toBeInTheDocument();
  });

  it('フォーカス取得不能（404）は取得不能案内を表示する', async () => {
    const { ApiError } = await import('../api');
    vi.mocked(fetchThread).mockRejectedValue(new ApiError(404, 'focus unavailable'));
    render(<ThreadView post={makePost()} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('この投稿は取得できません')).toBeInTheDocument());
  });

  it('失敗時はエラー表示＋再試行で再取得する', async () => {
    vi.mocked(fetchThread).mockRejectedValueOnce(new Error('boom')).mockResolvedValue(makeThread());
    render(<ThreadView post={makePost()} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('再試行')).toBeInTheDocument());
    fireEvent.click(screen.getByText('再試行'));
    await waitFor(() => expect(fetchThread).toHaveBeenCalledTimes(2));
  });

  it('閉じるボタンで onClose が呼ばれる', async () => {
    vi.mocked(fetchThread).mockResolvedValue(makeThread());
    const onClose = vi.fn();
    render(<ThreadView post={makePost()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc キーで onClose が呼ばれる', async () => {
    vi.mocked(fetchThread).mockResolvedValue(makeThread());
    const onClose = vi.fn();
    render(<ThreadView post={makePost()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('nostr は読み取り専用: 操作ボタンを描画しない', async () => {
    const nostrPost = makePost({ id: 'n1', provider: 'nostr', ref: 'nid', source: { id: 'nid' } });
    vi.mocked(fetchThread).mockResolvedValue(makeThread({ focus: nostrPost }));
    render(
      <ThreadView post={nostrPost} onClose={() => {}} onReply={() => {}} onQuote={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('focus text')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '返信' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '引用' })).not.toBeInTheDocument();
  });

  it('misskey は操作ボタンを描画する（reply/quote）', async () => {
    const mkPost = makePost({ id: 'm1', provider: 'misskey', ref: 'm1', source: { id: 'm1' } });
    vi.mocked(fetchThread).mockResolvedValue(makeThread({ focus: mkPost }));
    render(<ThreadView post={mkPost} onClose={() => {}} onReply={() => {}} onQuote={() => {}} />);
    await waitFor(() => expect(screen.getByText('focus text')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '返信' })).toBeInTheDocument();
  });

  it('Misskey の nextCursor があれば「さらに返信を読み込む」を表示し、追加分を継ぎ足す', async () => {
    const r1 = makePost({ id: 'r1', text: 'reply1 text' });
    const r2 = makePost({ id: 'r2', text: 'reply2 text' });
    vi.mocked(fetchThread)
      .mockResolvedValueOnce(makeThread({ replies: [node(r1, 1)], nextCursor: 'cur1' }))
      .mockResolvedValueOnce(makeThread({ replies: [node(r2, 1)], nextCursor: null }));
    render(<ThreadView post={makePost()} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('さらに返信を読み込む')).toBeInTheDocument());
    fireEvent.click(screen.getByText('さらに返信を読み込む'));
    await waitFor(() => expect(screen.getByText('reply2 text')).toBeInTheDocument());
    expect(vi.mocked(fetchThread).mock.calls[1][1]).toBe('cur1');
  });
});
