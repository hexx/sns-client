import { describe, expect, it } from 'vitest';
import { isNotificationsView, notifText, NOTIF_ICON, typeLabel } from './notifications';
import type { Notification, View } from '../../../shared/types';

function view(sources: View['sources']): View {
  return { id: 'v', name: 'v', sources };
}

describe('isNotificationsView', () => {
  it('通知 Source のみ → true', () => {
    expect(
      isNotificationsView(
        view([
          { provider: 'bluesky', kind: 'notifications' },
          { provider: 'misskey', kind: 'notifications' },
        ]),
      ),
    ).toBe(true);
  });

  it('Post Source のみ / 混在 / 空 → false', () => {
    expect(isNotificationsView(view([{ provider: 'bluesky', kind: 'home' }]))).toBe(false);
    expect(
      isNotificationsView(view([{ provider: 'bluesky', kind: 'notifications' }, { provider: 'bluesky', kind: 'home' }])),
    ).toBe(false);
    expect(isNotificationsView(view([]))).toBe(false);
  });
});

describe('notifText', () => {
  const base: Notification = {
    id: 'n1',
    provider: 'bluesky',
    type: 'like',
    createdAt: '2026-07-01T12:00:00Z',
    isRead: false,
    actor: { id: 'did:plc:alice', handle: 'alice.bsky.social', displayName: 'Alice' },
  };

  it('actor 系は「◯◯ さんが…」の文言になる', () => {
    expect(notifText({ ...base, type: 'like' })).toBe('Alice さんがあなたの投稿にいいねしました');
    expect(notifText({ ...base, type: 'reply' })).toBe('Alice さんがあなたに返信しました');
    expect(notifText({ ...base, type: 'follow' })).toBe('Alice さんがフォローしました');
  });

  it('reaction は絵文字キーを添える', () => {
    expect(notifText({ ...base, provider: 'misskey', type: 'reaction', reaction: ':kawaii:' })).toBe(
      'Alice さんがリアクションしました :kawaii:',
    );
  });

  it('pollEnded は actor 無しの文言（あなたのアンケート）', () => {
    expect(notifText({ ...base, actor: undefined, type: 'pollEnded' })).toBe('あなたのアンケートが終了しました');
  });

  it('actor が無く text も無い場合は「誰か」に縮退', () => {
    expect(notifText({ ...base, actor: undefined, type: 'like' })).toBe('誰かがあなたの投稿にいいねしました');
  });
});

describe('NOTIF_ICON / typeLabel', () => {
  it('主要タイプにアイコンがある', () => {
    expect(NOTIF_ICON.like).toBeTruthy();
    expect(NOTIF_ICON.reply).toBeTruthy();
    expect(NOTIF_ICON.follow).toBeTruthy();
  });

  it('typeLabel は主要タイプで人間可読', () => {
    expect(typeLabel('reply')).toBe('返信');
    expect(typeLabel('reaction')).toBe('リアクション');
    expect(typeLabel('verified')).toBe('認証');
  });
});
