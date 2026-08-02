import { describe, expect, it } from 'vitest';
import { isActorlessType, isNotificationsView, notifText, notifTextBody, NOTIF_ICON, typeLabel } from './notifications';
import type { Notification, NotificationType, View } from '../../../shared/types';

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

describe('notifTextBody（docs/profile-view-spec.md §8.1）', () => {
  const base: Notification = {
    id: 'n1',
    provider: 'bluesky',
    type: 'like',
    createdAt: '2026-07-01T12:00:00Z',
    isRead: false,
    actor: { id: 'did:plc:alice', handle: 'alice.bsky.social', displayName: 'Alice' },
  };

  it('actor 系は未完の句（notifText が前置きを合成できる形）', () => {
    expect(notifTextBody(base)).toBe('があなたの投稿にいいねしました');
    expect(notifTextBody({ ...base, type: 'follow' })).toBe('がフォローしました');
  });

  it('reaction は絵文字キーを添える', () => {
    expect(notifTextBody({ ...base, type: 'reaction', reaction: '👍' })).toBe('がリアクションしました 👍');
  });

  it('pollEnded は actor 無しの完文', () => {
    expect(notifTextBody({ ...base, type: 'pollEnded' })).toBe('あなたのアンケートが終了しました');
  });

  it('text のみ通知は BFF 合成の完文をそのまま返す', () => {
    expect(notifTextBody({ ...base, type: 'verified', text: 'あなたのアカウントが認証されました' })).toBe(
      'あなたのアカウントが認証されました',
    );
  });

  it('notifText は notifTextBody に前置きを足したものと一致する', () => {
    expect(notifText(base)).toBe(`${base.actor!.displayName} さん${notifTextBody(base)}`);
  });
});

describe('ACTORLESS_TYPES と notifTextBody の整合（docs/profile-view-spec.md §8.1）', () => {
  const base: Notification = {
    id: 'n1',
    provider: 'bluesky',
    type: 'like',
    createdAt: '2026-07-01T12:00:00Z',
    isRead: false,
    actor: { id: 'did:plc:alice', handle: 'alice.bsky.social', displayName: 'Alice' },
  };

  it('actorless 型の本文は完文（助詞で始まらない）で、notifText に前置きが付かない', () => {
    // ACTORLESS_TYPES に追加するときは notifTextBody の完文ケースも追加すること（二重主語の防止）
    const types: NotificationType[] = ['pollEnded'];
    for (const type of types) {
      expect(isActorlessType(type)).toBe(true);
      expect(notifTextBody({ ...base, type })).not.toMatch(/^(が|から|の|への)/);
      expect(notifText({ ...base, type, actor: undefined })).not.toMatch(/^(誰か|Alice)/);
    }
  });

  it('actor 前置き型の本文は助詞で始まる（前置きと連結できる）', () => {
    for (const type of ['like', 'follow', 'mention', 'reply'] as NotificationType[]) {
      expect(notifTextBody({ ...base, type })).toMatch(/^(が|から|の|への)/);
    }
  });
});
