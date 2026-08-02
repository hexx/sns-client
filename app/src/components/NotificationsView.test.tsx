import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotificationsView } from './NotificationsView';
import { api } from '../api';
import type { Notification, NotificationsResponse, Post } from '../../../shared/types';

// ApiError は実物を維持（instanceof のため）、api のメソッドだけモック
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      notifications: vi.fn(),
      markNotificationsRead: vi.fn(() => Promise.resolve({})),
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
  last.callback(
    [{ isIntersecting: true } as IntersectionObserverEntry],
    last as unknown as IntersectionObserver,
  );
}

const NOTIF_SOURCES = [
  { provider: 'bluesky' as const, kind: 'notifications' },
  { provider: 'misskey' as const, kind: 'notifications' },
];

function notif(over: Partial<Notification> = {}): Notification {
  return {
    id: 'n1',
    provider: 'bluesky',
    type: 'follow',
    createdAt: '2026-07-01T12:00:00Z',
    isRead: false,
    actor: { id: 'did:plc:alice', handle: 'alice.bsky.social', displayName: 'Alice' },
    ...over,
  };
}

function resp(notifications: Notification[], unreadCount = 0, nextCursor: string | null = null): NotificationsResponse {
  return { notifications, unreadCount, nextCursor };
}

const mockNotifications = vi.mocked(api.notifications);
const mockMarkRead = vi.mocked(api.markNotificationsRead);

beforeEach(() => {
  vi.clearAllMocks();
  ioInstances = [];
  // セットアップの IntersectionObserver スタブを捕捉可能なモックに差し替える
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  // デフォルト: 両プロバイダとも空
  mockNotifications.mockImplementation(async (provider: string) =>
    provider === 'bluesky' ? resp([]) : resp([], 0, null),
  );
  mockMarkRead.mockResolvedValue({});
  // ポーリング（15秒間隔）はテスト中に発火しないためタイマー制御は不要
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NotificationsView', () => {
  it('初期読み込み: 両プロバイダの通知を時系列合成して描画する', async () => {
    mockNotifications.mockImplementation(async (provider: string) => {
      if (provider === 'bluesky') {
        return resp([notif({ id: 'b1', createdAt: '2026-07-01T10:00:00Z', type: 'like' })], 1, null);
      }
      return resp([notif({ id: 'm1', provider: 'misskey', createdAt: '2026-07-01T12:00:00Z', type: 'reply' })], 0, null);
    });
    render(<NotificationsView sources={NOTIF_SOURCES} active={false} />);
    await waitFor(() => {
      // 合成は createdAt 降順: misskey(12:00) → bluesky(10:00)
      const texts = screen.getAllByText(/さん/).map((el) => el.textContent);
      expect(texts[0]).toContain('返信しました');
      expect(texts[1]).toContain('いいねしました');
    });
    expect(mockNotifications).toHaveBeenCalledWith('bluesky', undefined);
    expect(mockNotifications).toHaveBeenCalledWith('misskey', undefined);
  });

  it('未読数は合算して onPendingCountChange に通知する（タブバッジ用）', async () => {
    mockNotifications.mockImplementation(async (provider: string) => {
      if (provider === 'bluesky') return resp([], 2, null);
      return resp([], 3, null);
    });
    const onPending = vi.fn();
    render(<NotificationsView sources={NOTIF_SOURCES} active={false} onPendingCountChange={onPending} />);
    await waitFor(() => {
      expect(onPending).toHaveBeenCalledWith(5);
    });
  });

  it('active になった瞬間に全既読を呼ぶ（docs/notifications-spec.md §5）', async () => {
    const { rerender } = render(<NotificationsView sources={NOTIF_SOURCES} active={false} />);
    await waitFor(() => expect(mockNotifications).toHaveBeenCalled());
    expect(mockMarkRead).not.toHaveBeenCalled();
    rerender(<NotificationsView sources={NOTIF_SOURCES} active={true} />);
    await waitFor(() => {
      expect(mockMarkRead).toHaveBeenCalled();
    });
  });

  it('投稿を伴う通知のクリックで Thread を開く（post.ref エコー）', async () => {
    const post: Post = {
      id: 'at://did/app.bsky.feed.post/mine',
      provider: 'bluesky',
      author: { id: 'did:plc:me', handle: 'me.bsky.social', displayName: 'Me' },
      text: '対象投稿',
      createdAt: '2026-07-01T11:00:00Z',
      media: [],
      stats: { replies: 0, reposts: 0, likes: 0 },
      source: {},
    };
    mockNotifications.mockImplementation(async (provider: string) =>
      provider === 'bluesky' ? resp([notif({ type: 'like', post })]) : resp([]),
    );
    const onOpenThread = vi.fn();
    render(<NotificationsView sources={NOTIF_SOURCES} active={false} onOpenThread={onOpenThread} />);
    await waitFor(() => {
      expect(screen.getByRole('button')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button'));
    expect(onOpenThread).toHaveBeenCalledWith(post);
  });

  it('postUnavailable は遷移なし（案内行のみ）', async () => {
    mockNotifications.mockImplementation(async (provider: string) =>
      provider === 'bluesky' ? resp([notif({ type: 'like', postUnavailable: true })]) : resp([]),
    );
    const onOpenThread = vi.fn();
    render(<NotificationsView sources={NOTIF_SOURCES} active={false} onOpenThread={onOpenThread} />);
    await waitFor(() => {
      expect(screen.getByText('投稿は取得できません')).toBeTruthy();
    });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('無限スクロール: 最古が新しい側のプロバイダを cursor 付きで追記する', async () => {
    mockNotifications.mockImplementation(async (provider: string, cursor?: string) => {
      if (provider === 'bluesky') {
        if (!cursor) return resp([notif({ id: 'b1', createdAt: '2026-07-01T10:00:00Z' })], 0, 'b-cur');
        return resp([notif({ id: 'b2', createdAt: '2026-07-01T08:00:00Z' })], 0, null);
      }
      return resp([notif({ id: 'm1', provider: 'misskey', createdAt: '2026-07-01T09:00:00Z' })], 0, 'm-cur');
    });
    render(<NotificationsView sources={NOTIF_SOURCES} active={false} />);
    await waitFor(() => {
      expect(screen.getAllByText(/フォローしました/)).toHaveLength(2);
    });
    await act(async () => {
      triggerIntersection();
    });
    await waitFor(() => {
      // 最古が新しいのは bluesky（b1@10:00 > m1@09:00）→ bluesky を b-cur で追記
      expect(mockNotifications).toHaveBeenCalledWith('bluesky', 'b-cur');
      expect(screen.getAllByText(/フォローしました/)).toHaveLength(3);
    });
  });
});
