import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MobilePager } from './MobilePager';
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
      sources: vi.fn(),
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

function triggerIntersection(overrides: Partial<IntersectionObserverEntry> = {}): void {
  const last = ioInstances[ioInstances.length - 1];
  last.callback(
    [{ isIntersecting: true, ...overrides } as IntersectionObserverEntry],
    last as unknown as IntersectionObserver,
  );
}

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    provider: 'bluesky',
    author: { id: 'did:plc:alice', handle: 'alice.bsky.social', displayName: 'Alice' },
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

function Pager(props: { views: View[]; initial?: string; onSwitchView?: (id: string) => void }) {
  const [active, setActive] = useState(props.initial ?? props.views[0].id);
  return (
    <MobilePager
      views={props.views}
      activeViewId={active}
      onSwitchView={(id) => {
        setActive(id);
        props.onSwitchView?.(id);
      }}
      onCompose={() => {}}
      onReply={() => {}}
      onQuote={() => {}}
      justPosted={null}
    />
  );
}

beforeEach(() => {
  ioInstances = [];
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  vi.mocked(api.timeline).mockResolvedValue({ posts: [], nextCursor: null });
  vi.mocked(api.sources).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MobilePager（単一 Source）', () => {
  it('初回読込でタイムラインを描画する', async () => {
    vi.mocked(api.timeline).mockResolvedValue({ posts: [makePost({ id: 'p1', text: 'first' })], nextCursor: 'c1' });
    render(<Pager views={[bskyView]} />);
    expect(await screen.findByText('first')).toBeInTheDocument();
    expect(api.timeline).toHaveBeenCalledWith({ provider: 'bluesky', kind: 'home' });
  });

  it('読込失敗でエラーバナーと再試行ボタンを出す', async () => {
    const user = userEvent.setup();
    vi.mocked(api.timeline)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ posts: [makePost({ text: 'recovered' })], nextCursor: null });
    render(<Pager views={[bskyView]} />);

    expect(await screen.findByText(/network down/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByText('recovered')).toBeInTheDocument();
  });

  it('sentinel 表示で追加を読み込む（無限スクロール）', async () => {
    vi.mocked(api.timeline)
      .mockResolvedValueOnce({ posts: [makePost({ id: 'p1', text: 'first' })], nextCursor: 'c1' })
      .mockResolvedValueOnce({ posts: [makePost({ id: 'p2', text: 'second' })], nextCursor: null });
    render(<Pager views={[bskyView]} />);
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

    render(<Pager views={[bskyView]} />);
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
    // 取り込んだ新着だけ未読強調され、最古の未読の直下に区切り線が入る（docs/unread-divider-spec.md §3）
    expect(articles[0]).toHaveClass('unread');
    expect(articles[1]).not.toHaveClass('unread');
    expect(screen.getByText('新着はここまで')).toBeInTheDocument();
  });

  it('区切り線をスクロールで通過すると未読が即座に消える（§3.4。フェードなし）', async () => {
    vi.useFakeTimers();
    const p1 = makePost({ id: 'p1', text: 'first' });
    const p2 = makePost({ id: 'p2', text: 'second' });
    vi.mocked(api.timeline)
      .mockResolvedValueOnce({ posts: [p1], nextCursor: null })
      .mockResolvedValue({ posts: [p1, p2], nextCursor: null });

    render(<Pager views={[bskyView]} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    await act(async () => {
      screen.getByRole('button', { name: /新着 1 件/ }).click();
    });
    expect(screen.getByText('新着はここまで')).toBeInTheDocument();

    // 上方向オーバーバウンス（区切り線が一時的に可視領域の下部から外れる）ではクリアしない
    await act(async () => {
      triggerIntersection({
        isIntersecting: false,
        boundingClientRect: { top: 800, bottom: 820 } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 600 } as DOMRectReadOnly,
      });
    });
    expect(screen.getByText('新着はここまで')).toBeInTheDocument();
    expect(screen.getAllByRole('article')[0]).toHaveClass('unread');

    // スクロール通過（区切り線が可視領域の上部から完全に外れる）→ 即座にクリア
    await act(async () => {
      triggerIntersection({
        isIntersecting: false,
        boundingClientRect: { top: -30, bottom: -10 } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 600 } as DOMRectReadOnly,
      });
    });
    expect(screen.queryByText('新着はここまで')).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')[0]).not.toHaveClass('unread');
  });

  it('追加取り込みは未読を差し替える: 旧未読は未通過でも破棄され新境界が新設される（§3.3）', async () => {
    vi.useFakeTimers();
    const p1 = makePost({ id: 'p1', text: 'first', createdAt: '2026-07-01T12:00:00Z' });
    const p2 = makePost({ id: 'p2', text: 'second', createdAt: '2026-07-01T12:01:00Z' });
    const p3 = makePost({ id: 'p3', text: 'third', createdAt: '2026-07-01T12:02:00Z' });
    let posts = [p1];
    vi.mocked(api.timeline).mockImplementation(async () => ({ posts: [...posts], nextCursor: null }));

    render(<Pager views={[bskyView]} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // 1回目を取り込み（未読: second）
    posts = [p1, p2];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    await act(async () => {
      screen.getByRole('button', { name: /新着 1 件/ }).click();
    });
    expect(screen.getAllByRole('article')[0]).toHaveClass('unread');

    // 境界を通過せずに 2回目を取り込み → 差し替え
    posts = [p1, p2, p3];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    await act(async () => {
      screen.getByRole('button', { name: /新着 1 件/ }).click();
    });

    const articles = screen.getAllByRole('article');
    expect(articles[0]).toHaveTextContent('third');
    expect(articles[0]).toHaveClass('unread');
    expect(articles[1]).toHaveTextContent('second');
    expect(articles[1]).not.toHaveClass('unread'); // 旧未読は破棄される
    expect(screen.getByText('新着はここまで')).toBeInTheDocument();
  });

  it('新着0件の手動更新（pull-to-refresh）は既存の未読表示を維持する（§3.3 / §4.3）', async () => {
    vi.useFakeTimers();
    const p1 = makePost({ id: 'p1', text: 'first' });
    const p2 = makePost({ id: 'p2', text: 'second' });
    let posts = [p1];
    vi.mocked(api.timeline).mockImplementation(async () => ({ posts: [...posts], nextCursor: null }));

    render(<Pager views={[bskyView]} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    posts = [p1, p2];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    await act(async () => {
      screen.getByRole('button', { name: /新着 1 件/ }).click();
    });
    expect(screen.getByText('新着はここまで')).toBeInTheDocument();

    // pull-to-refresh（新着なし: 同一ポストのみ返る）
    const scroll = document.querySelector('.scroll') as HTMLElement;
    await act(async () => {
      fireEvent.touchStart(scroll, { touches: [{ clientX: 300, clientY: 100 }] });
      fireEvent.touchMove(scroll, { touches: [{ clientX: 300, clientY: 300 }] }); // dy=+200 → pull=100 ≥ 閾値
      fireEvent.touchEnd(scroll, { changedTouches: [{ clientX: 300, clientY: 300 }] });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // 未読は差し替えられず維持される
    expect(screen.getByText('新着はここまで')).toBeInTheDocument();
    expect(screen.getAllByRole('article')[0]).toHaveClass('unread');
  });
});

describe('MobilePager（複数 Source 合成）', () => {
  it('2つの Source を時系列で合成して描画する', async () => {
    vi.mocked(api.timeline).mockImplementation(async (source) => {
      if (source.provider === 'bluesky') {
        return { posts: [makePost({ id: 'b1', provider: 'bluesky', text: 'bsky-old', createdAt: '2026-07-01T10:00:00Z' })], nextCursor: null };
      }
      return { posts: [makePost({ id: 'm1', provider: 'misskey', text: 'mk-new', createdAt: '2026-07-01T11:00:00Z' })], nextCursor: null };
    });
    render(<Pager views={[mergedView]} />);
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
    render(<Pager views={[mergedView]} />);
    expect(await screen.findByText('bsky-ok')).toBeInTheDocument();
    expect(await screen.findByText(/misskey: misskey down/)).toBeInTheDocument();
  });
});

describe('MobilePager（ページング操作。docs/mobile-paging-spec.md §4–§5）', () => {
  const techView: View = { id: 'tech', name: '技術', sources: [{ provider: 'misskey', kind: 'list', id: 'l1' }] };
  const twoViews: View[] = [bskyView, techView];

  // フリック速度判定は performance.now() ベース。テスト側で時刻を制御する
  let now = 0;
  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  function touch(el: HTMLElement, type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number, t: number): void {
    now = t;
    fireEvent[type](el, {
      touches: type === 'touchEnd' ? [] : [{ clientX: x, clientY: y }],
      changedTouches: [{ clientX: x, clientY: y }],
    });
  }

  it('タブタップでその View へ切替わる', async () => {
    const user = userEvent.setup();
    const onSwitchView = vi.fn();
    render(<Pager views={twoViews} onSwitchView={onSwitchView} />);

    await user.click(screen.getByRole('tab', { name: '技術' }));
    expect(onSwitchView).toHaveBeenCalledWith('tech');
    expect(screen.getByRole('tab', { name: '技術' })).toHaveAttribute('aria-selected', 'true');
  });

  it('左スワイプ（距離十分）で次の View へ切替わる', async () => {
    const onSwitchView = vi.fn();
    render(<Pager views={twoViews} onSwitchView={onSwitchView} />);
    const viewport = document.querySelector('.pager-viewport') as HTMLElement;

    touch(viewport, 'touchStart', 300, 100, 0);
    touch(viewport, 'touchMove', 290, 100, 100); // スロップ超 → 横ロック
    touch(viewport, 'touchMove', 0, 102, 500); // dx=-300（jsdom 幅1024の25%以上）
    touch(viewport, 'touchEnd', 0, 102, 1000); // 低速 → 距離判定のみ

    expect(onSwitchView).toHaveBeenCalledWith('tech');
  });

  it('短い低速スワイプはスナップバックし切替わらない', () => {
    const onSwitchView = vi.fn();
    render(<Pager views={twoViews} onSwitchView={onSwitchView} />);
    const viewport = document.querySelector('.pager-viewport') as HTMLElement;

    touch(viewport, 'touchStart', 300, 100, 0);
    touch(viewport, 'touchMove', 280, 100, 100); // 横ロック
    touch(viewport, 'touchMove', 270, 100, 900); // dx=-30, 低速
    touch(viewport, 'touchEnd', 270, 100, 1000);

    expect(onSwitchView).not.toHaveBeenCalled();
  });

  it('縦スワイプ（縦ロック）はページ切替にならない', () => {
    const onSwitchView = vi.fn();
    render(<Pager views={twoViews} onSwitchView={onSwitchView} />);
    const viewport = document.querySelector('.pager-viewport') as HTMLElement;

    touch(viewport, 'touchStart', 300, 100, 0);
    touch(viewport, 'touchMove', 300, 130, 100); // 縦ロック
    touch(viewport, 'touchMove', 300, 400, 200);
    touch(viewport, 'touchEnd', 300, 400, 300);

    expect(onSwitchView).not.toHaveBeenCalled();
  });

  it('先頭ページで右スワイプしても切替わらない（端でクランプ）', () => {
    const onSwitchView = vi.fn();
    render(<Pager views={twoViews} onSwitchView={onSwitchView} />);
    const viewport = document.querySelector('.pager-viewport') as HTMLElement;

    touch(viewport, 'touchStart', 100, 100, 0);
    touch(viewport, 'touchMove', 120, 100, 100);
    touch(viewport, 'touchMove', 500, 100, 200); // dx=+400
    touch(viewport, 'touchEnd', 500, 100, 300);

    expect(onSwitchView).not.toHaveBeenCalled();
  });

  it('非アクティブ View の新着はタブバッジで知らせ、タブタップで自動取り込み＋未読境界を表示する（§4.4 三層）', async () => {
    vi.useFakeTimers();
    const p1 = makePost({ id: 'p1', text: 'first' });
    const p2 = makePost({ id: 'p2', text: 'second' });
    let bskyCalls = 0;
    vi.mocked(api.timeline).mockImplementation(async (source) => {
      if (source.provider !== 'bluesky') return { posts: [], nextCursor: null };
      // 初回は1件、ポーリングで2件目が見つかる
      bskyCalls += 1;
      return bskyCalls <= 1 ? { posts: [p1], nextCursor: null } : { posts: [p1, p2], nextCursor: null };
    });

    // アクティブを「技術」（新着なし）にして、「ホーム」の新着がバッジに出ることを見る
    render(<Pager views={twoViews} initial="tech" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });

    // 非アクティブの「ホーム」タブにバッジ 1。アクティブタブには出ない
    expect(screen.getByRole('tab', { name: /ホーム/ })).toHaveTextContent('1');
    expect(screen.getByRole('tab', { name: '技術' })).not.toHaveTextContent('1');

    // ホームのタブをタップ → 自動取り込み: バッジ消去、ピルは出ず、投稿挿入＋区切り線（unread-divider-spec §4.2）
    await act(async () => {
      screen.getByRole('tab', { name: /ホーム/ }).click();
    });
    expect(screen.getByRole('tab', { name: 'ホーム' })).not.toHaveTextContent('1');
    expect(screen.queryByRole('button', { name: /新着/ })).not.toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getByText('新着はここまで')).toBeInTheDocument();
    // 未読強調は新着投稿のみ
    const unreadArticles = screen.getAllByRole('article').filter((a) => a.classList.contains('unread'));
    expect(unreadArticles).toHaveLength(1);
    expect(unreadArticles[0]).toHaveTextContent('second');
  });

  it('スワイプ移動では自動取り込みせず、ピルに引き継ぐ（unread-divider-spec §4.2）', async () => {
    vi.useFakeTimers();
    const p1 = makePost({ id: 'p1', text: 'first' });
    const p2 = makePost({ id: 'p2', text: 'second' });
    let bskyCalls = 0;
    vi.mocked(api.timeline).mockImplementation(async (source) => {
      if (source.provider !== 'bluesky') return { posts: [], nextCursor: null };
      bskyCalls += 1;
      return bskyCalls <= 1 ? { posts: [p1], nextCursor: null } : { posts: [p1, p2], nextCursor: null };
    });

    render(<Pager views={twoViews} initial="tech" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    expect(screen.getByRole('tab', { name: /ホーム/ })).toHaveTextContent('1');

    // 左スワイプでホームへ（距離十分）
    const viewport = document.querySelector('.pager-viewport') as HTMLElement;
    await act(async () => {
      touch(viewport, 'touchStart', 300, 100, 0);
      touch(viewport, 'touchMove', 290, 100, 100); // スロップ超 → 横ロック
      touch(viewport, 'touchMove', 0, 102, 500); // dx=-300
      touch(viewport, 'touchEnd', 0, 102, 1000);
    });

    // 自動取り込みは起きず、ページ内ピルがシグナルを引き継ぐ。区切り線はまだ無い
    expect(screen.getByRole('button', { name: /新着 1 件/ })).toBeInTheDocument();
    expect(screen.queryByText('新着はここまで')).not.toBeInTheDocument();
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
    render(<Pager views={[mkView]} />);
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
    render(<Pager views={[mkView]} />);
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
