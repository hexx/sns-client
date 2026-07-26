import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Timeline } from './Timeline';
import { api } from '../api';
import type { Post, View } from '../../../shared/types';

// ApiError は実物を維持（instanceof のため）、api のメソッドだけモック
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      health: vi.fn(),
      views: vi.fn(),
      providers: vi.fn(),
      timeline: vi.fn(),
      uploadMedia: vi.fn(),
      post: vi.fn(),
      react: vi.fn(),
      emojis: vi.fn(),
    },
  };
});

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
  last.callback([{ isIntersecting: true } as IntersectionObserverEntry], last as unknown as IntersectionObserver);
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

const bskyView: View = { id: 'home', name: 'ホーム', sources: [{ provider: 'bluesky', kind: 'home' }] };
const mergedView: View = {
  id: 'home',
  name: 'ホーム',
  sources: [
    { provider: 'bluesky', kind: 'home' },
    { provider: 'misskey', kind: 'home' },
  ],
};

const handlers = {
  onSwitchView: () => {},
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

describe('Timeline（単一 Source）', () => {
  it('初回読込でタイムラインを描画する', async () => {
    vi.mocked(api.timeline).mockResolvedValue({ posts: [makePost({ id: 'p1', text: 'first' })], nextCursor: 'c1' });
    render(<Timeline view={bskyView} views={[bskyView]} {...handlers} justPosted={null} />);
    expect(await screen.findByText('first')).toBeInTheDocument();
    expect(api.timeline).toHaveBeenCalledWith({ provider: 'bluesky', kind: 'home' });
  });

  it('読込失敗でエラーバナーと再試行ボタンを出す', async () => {
    const user = userEvent.setup();
    vi.mocked(api.timeline)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ posts: [makePost({ text: 'recovered' })], nextCursor: null });
    render(<Timeline view={bskyView} views={[bskyView]} {...handlers} justPosted={null} />);

    expect(await screen.findByText(/network down/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByText('recovered')).toBeInTheDocument();
  });

  it('sentinel 表示で追加を読み込む（無限スクロール）', async () => {
    vi.mocked(api.timeline)
      .mockResolvedValueOnce({ posts: [makePost({ id: 'p1', text: 'first' })], nextCursor: 'c1' })
      .mockResolvedValueOnce({ posts: [makePost({ id: 'p2', text: 'second' })], nextCursor: null });
    render(<Timeline view={bskyView} views={[bskyView]} {...handlers} justPosted={null} />);
    expect(await screen.findByText('first')).toBeInTheDocument();

    await act(async () => {
      triggerIntersection();
    });
    expect(await screen.findByText('second')).toBeInTheDocument();
    expect(api.timeline).toHaveBeenLastCalledWith({ provider: 'bluesky', kind: 'home' }, 'c1');
  });

  it('ポーリングで新着を検知し、ピルタップで先頭に挿入する', async () => {
    vi.useFakeTimers();
    const p1 = makePost({ id: 'p1', text: 'first' });
    const p2 = makePost({ id: 'p2', text: 'second' });
    vi.mocked(api.timeline)
      .mockResolvedValueOnce({ posts: [p1], nextCursor: null })
      .mockResolvedValue({ posts: [p1, p2], nextCursor: null });

    render(<Timeline view={bskyView} views={[bskyView]} {...handlers} justPosted={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('first')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    const pill = screen.getByRole('button', { name: /新着 1 件/ });
    expect(pill).toBeInTheDocument();

    await act(async () => {
      pill.click();
    });
    const articles = screen.getAllByRole('article');
    expect(articles[0]).toHaveTextContent('second');
    expect(articles[1]).toHaveTextContent('first');
    expect(screen.queryByRole('button', { name: /新着/ })).not.toBeInTheDocument();
  });

  it('justPosted を先頭に反映し、重複を排除する', async () => {
    vi.mocked(api.timeline).mockResolvedValue({ posts: [makePost({ id: 'p1', text: 'first' })], nextCursor: null });
    const { rerender } = render(<Timeline view={bskyView} views={[bskyView]} {...handlers} justPosted={null} />);
    expect(await screen.findByText('first')).toBeInTheDocument();

    rerender(<Timeline view={bskyView} views={[bskyView]} {...handlers} justPosted={makePost({ id: 'p2', text: 'mine' })} />);
    expect(await screen.findByText('mine')).toBeInTheDocument();
    let articles = screen.getAllByRole('article');
    expect(articles[0]).toHaveTextContent('mine');
    expect(articles[1]).toHaveTextContent('first');

    rerender(<Timeline view={bskyView} views={[bskyView]} {...handlers} justPosted={makePost({ id: 'p1', text: 'first' })} />);
    articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(2);
  });
});

describe('Timeline（複数 Source 合成）', () => {
  it('2つの Source を時系列で合成して描画する', async () => {
    vi.mocked(api.timeline).mockImplementation(async (source) => {
      if (source.provider === 'bluesky') {
        return { posts: [makePost({ id: 'b1', provider: 'bluesky', text: 'bsky-old', createdAt: '2026-07-01T10:00:00Z' })], nextCursor: null };
      }
      return { posts: [makePost({ id: 'm1', provider: 'misskey', text: 'mk-new', createdAt: '2026-07-01T11:00:00Z' })], nextCursor: null };
    });
    render(<Timeline view={mergedView} views={[mergedView]} {...handlers} justPosted={null} />);
    expect(await screen.findByText('mk-new')).toBeInTheDocument();
    expect(await screen.findByText('bsky-old')).toBeInTheDocument();
    const articles = screen.getAllByRole('article');
    expect(articles[0]).toHaveTextContent('mk-new'); // 新しい方が先頭
    expect(articles[1]).toHaveTextContent('bsky-old');
  });

  it('片方の Source が失敗しても他方は表示する（部分障害）', async () => {
    vi.mocked(api.timeline).mockImplementation(async (source) => {
      if (source.provider === 'bluesky') {
        return { posts: [makePost({ id: 'b1', text: 'bsky-ok' })], nextCursor: null };
      }
      throw new Error('misskey down');
    });
    render(<Timeline view={mergedView} views={[mergedView]} {...handlers} justPosted={null} />);
    expect(await screen.findByText('bsky-ok')).toBeInTheDocument();
    expect(await screen.findByText(/misskey: misskey down/)).toBeInTheDocument();
  });
});

describe('リアクション楽観更新（docs/misskey-reaction-action-spec.md）', () => {
  const mkView: View = { id: 'home', name: 'ホーム', sources: [{ provider: 'misskey', kind: 'home' }] };

  function mkPost(over: Partial<Post> = {}): Post {
    return makePost({ id: 'm1', provider: 'misskey', ref: 'note-1', ...over });
  }

  it('「＋」→ピッカー選択で楽観付与し、ref を target に API へ送る', async () => {
    const user = userEvent.setup();
    vi.mocked(api.timeline).mockResolvedValue({ posts: [mkPost({ text: 'mk-post' })], nextCursor: null });
    vi.mocked(api.react).mockResolvedValue({ reaction: '👍' });
    vi.mocked(api.emojis).mockResolvedValue([]);
    render(<Timeline view={mkView} views={[mkView]} {...handlers} justPosted={null} />);
    expect(await screen.findByText('mk-post')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'リアクションを追加' }));
    await user.click(screen.getByTitle('👍')); // Unicode パレット

    expect(await screen.findByText('1')).toBeInTheDocument(); // 楽観で count 表示
    expect(api.react).toHaveBeenCalledWith('note-1', '👍');
  });

  it('失敗時はロールバックしトーストを出す', async () => {
    const user = userEvent.setup();
    vi.mocked(api.timeline).mockResolvedValue({
      posts: [mkPost({ text: 'mk-post', reactions: [{ emoji: '👍', count: 2 }], stats: { replies: 0, reposts: 0, likes: 2 } })],
      nextCursor: null,
    });
    // 拒否をテスト側から制御する（楽観状態の表明より先に沈下する競合を避ける）
    let rejectReact!: (e: Error) => void;
    vi.mocked(api.react).mockReturnValue(new Promise((_resolve, reject) => (rejectReact = reject)));
    render(<Timeline view={mkView} views={[mkView]} {...handlers} justPosted={null} />);
    expect(await screen.findByText('2')).toBeInTheDocument();

    await user.click(screen.getByTitle('👍')); // 相乗り → 楽観で 3
    expect(await screen.findByText('3')).toBeInTheDocument();

    // 失敗を確定 → 元へ戻る＋トースト
    await act(async () => rejectReact(new Error('ALREADY_REACTED')));
    expect(await screen.findByText('リアクションに失敗しました')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
    expect(screen.queryByText('3')).not.toBeInTheDocument();
  });
});
