import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Timeline } from './Timeline';
import { api } from '../api';
import type { Post } from '../../../shared/types';

vi.mock('../api', () => ({
  api: {
    health: vi.fn(),
    timeline: vi.fn(),
    uploadMedia: vi.fn(),
    post: vi.fn(),
  },
}));

// --- IntersectionObserver を捕捉し、テスト側から発火できるようにする ---
type IOInstance = { callback: IntersectionObserverCallback };
let ioInstances: IOInstance[] = [];

class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    ioInstances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function triggerIntersection(): void {
  const last = ioInstances[ioInstances.length - 1];
  last.callback(
    [{ isIntersecting: true } as IntersectionObserverEntry],
    last as unknown as IntersectionObserver,
  );
}

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    provider: 'bluesky',
    author: { handle: 'alice.bsky.social', displayName: 'Alice' },
    text: 'hello',
    createdAt: '2026-07-01T12:00:00Z',
    media: [],
    stats: { replies: 0, reposts: 0, likes: 0 },
    source: { uri: 'at://x', cid: 'c' },
    ...overrides,
  };
}

const handlers = {
  onCompose: () => {},
  onReply: () => {},
  onQuote: () => {},
};

beforeEach(() => {
  ioInstances = [];
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  vi.mocked(api.timeline).mockResolvedValue({ posts: [], nextCursor: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Timeline', () => {
  it('初回読込でタイムラインを描画する', async () => {
    vi.mocked(api.timeline).mockResolvedValue({
      posts: [makePost({ id: 'p1', text: 'first' })],
      nextCursor: 'c1',
    });
    render(<Timeline {...handlers} justPosted={null} />);
    expect(await screen.findByText('first')).toBeInTheDocument();
    expect(api.timeline).toHaveBeenCalledWith();
  });

  it('読込失敗でエラーバナーと再試行ボタンを出す', async () => {
    const user = userEvent.setup();
    vi.mocked(api.timeline)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ posts: [makePost({ text: 'recovered' })], nextCursor: null });
    render(<Timeline {...handlers} justPosted={null} />);

    expect(await screen.findByText(/network down/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByText('recovered')).toBeInTheDocument();
  });

  it('sentinel 表示で追加を読み込む（無限スクロール）', async () => {
    vi.mocked(api.timeline)
      .mockResolvedValueOnce({ posts: [makePost({ id: 'p1', text: 'first' })], nextCursor: 'c1' })
      .mockResolvedValueOnce({ posts: [makePost({ id: 'p2', text: 'second' })], nextCursor: null });
    render(<Timeline {...handlers} justPosted={null} />);
    expect(await screen.findByText('first')).toBeInTheDocument();

    await act(async () => {
      triggerIntersection();
    });
    expect(await screen.findByText('second')).toBeInTheDocument();
    expect(api.timeline).toHaveBeenLastCalledWith('c1');
  });

  it('ポーリングで新着を検知し、ピルタップで先頭に挿入する', async () => {
    vi.useFakeTimers();
    const p1 = makePost({ id: 'p1', text: 'first' });
    const p2 = makePost({ id: 'p2', text: 'second' });
    vi.mocked(api.timeline)
      .mockResolvedValueOnce({ posts: [p1], nextCursor: null }) // 初回
      .mockResolvedValue({ posts: [p1, p2], nextCursor: null }); // 新着チェック

    render(<Timeline {...handlers} justPosted={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // 初回読込をフラッシュ
    });
    expect(screen.getByText('first')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000); // ポーリング発火
    });
    const pill = screen.getByRole('button', { name: /新着 1 件/ });
    expect(pill).toBeInTheDocument();

    await act(async () => {
      pill.click(); // 新着を適用
    });
    const articles = screen.getAllByRole('article');
    expect(articles[0]).toHaveTextContent('second'); // 新着が先頭
    expect(articles[1]).toHaveTextContent('first');
    expect(screen.queryByRole('button', { name: /新着/ })).not.toBeInTheDocument();
  });

  it('justPosted を先頭に反映し、重複を排除する', async () => {
    vi.mocked(api.timeline).mockResolvedValue({
      posts: [makePost({ id: 'p1', text: 'first' })],
      nextCursor: null,
    });
    const { rerender } = render(<Timeline {...handlers} justPosted={null} />);
    expect(await screen.findByText('first')).toBeInTheDocument();

    // 新規投稿 → 先頭に挿入
    rerender(<Timeline {...handlers} justPosted={makePost({ id: 'p2', text: 'mine' })} />);
    expect(await screen.findByText('mine')).toBeInTheDocument();
    let articles = screen.getAllByRole('article');
    expect(articles[0]).toHaveTextContent('mine');
    expect(articles[1]).toHaveTextContent('first');

    // 既存と同じ id → 重複しない
    rerender(<Timeline {...handlers} justPosted={makePost({ id: 'p1', text: 'first' })} />);
    articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(2);
  });
});
