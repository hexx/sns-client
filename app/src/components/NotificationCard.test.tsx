// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NotificationCard } from './NotificationCard';
import type { Notification } from '../../../shared/types';

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

describe('NotificationCard のプロフィール入口（docs/profile-view-spec.md §8.1）', () => {
  it('onOpenProfile 有り: actor のアバター＋名前がボタンになり、クリックで発火する', () => {
    const onOpenProfile = vi.fn();
    render(<NotificationCard notification={notif()} onOpenProfile={onOpenProfile} />);
    fireEvent.click(screen.getByRole('button', { name: 'Alice のプロフィールを開く' }));
    expect(onOpenProfile).toHaveBeenCalledWith('bluesky', expect.objectContaining({ id: 'did:plc:alice' }));
  });

  it('投稿を伴う通知で actor をクリックしても Thread は開かない（stopPropagation）', () => {
    const onOpenThread = vi.fn();
    const onOpenProfile = vi.fn();
    render(
      <NotificationCard
        notification={notif({
          type: 'mention',
          post: {
            id: 'at://x',
            provider: 'bluesky',
            author: notif().actor as never,
            text: 'こんにちは',
            createdAt: '2026-07-01T12:00:00Z',
            media: [],
            stats: { replies: 0, reposts: 0, likes: 0 },
            ref: { uri: 'at://x', cid: 'c' },
            source: {},
          } as never,
        })}
        onOpenThread={onOpenThread}
        onOpenProfile={onOpenProfile}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Alice のプロフィールを開く' }));
    expect(onOpenProfile).toHaveBeenCalledTimes(1);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('onOpenProfile が無ければ actor はボタン化しない（従来の文言表示のまま）', () => {
    render(<NotificationCard notification={notif()} />);
    expect(screen.queryByRole('button', { name: 'Alice' })).toBeNull();
    expect(screen.getByText(/フォローしました/)).toBeTruthy();
  });

  it('actor 無しの通知は本文をそのまま表示する（ボタン化しない）', () => {
    render(
      <NotificationCard
        notification={notif({ actor: undefined, type: 'login', text: '新しいデバイスからログインしました' })}
        onOpenProfile={vi.fn()}
      />,
    );
    expect(screen.getByText('新しいデバイスからログインしました')).toBeTruthy();
  });

  it('text のみ通知に actor が居てもボタン化しない（BFF 合成の完文が本体。二重主語の防止。§8.1）', () => {
    render(
      <NotificationCard
        notification={notif({ type: 'verified', text: 'あなたのアカウントが認証されました' })}
        onOpenProfile={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Alice のプロフィールを開く' })).toBeNull();
    expect(screen.getByText('あなたのアカウントが認証されました')).toBeTruthy();
    expect(screen.queryByText(/Alice さん.*認証されました/)).toBeNull();
  });
});
