import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TimelineCore } from './TimelineCore';
import { api } from '../api';
import { muteUser, resetModerationForTests } from '../lib/moderation';
import type { Post } from '../../../shared/types';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { ...actual.api, timeline: vi.fn(), mute: vi.fn().mockResolvedValue({}) },
  };
});

function makePost(id: string, handle: string): Post {
  return {
    id,
    provider: 'bluesky',
    author: { id: `did:plc:${handle}`, handle: `${handle}.bsky.social`, displayName: handle },
    text: `${handle} text`,
    createdAt: '2026-07-01T12:00:00Z',
    media: [],
    stats: { replies: 0, reposts: 0, likes: 0 },
    ref: { uri: `at://${handle}`, cid: 'c' },
    source: {},
  };
}

beforeEach(() => {
  resetModerationForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  resetModerationForTests();
});

describe('TimelineCore（docs/block-mute-spec.md §5.4 即時反映）', () => {
  it('ミュート成功で該当ユーザーの投稿が画面から即時除去される', async () => {
    const alice = makePost('p1', 'alice');
    const bob = makePost('p2', 'bob');
    vi.mocked(api.timeline).mockResolvedValue({ posts: [alice, bob], nextCursor: null });
    render(<TimelineCore sources={[{ provider: 'bluesky', kind: 'home' }]} />);
    await waitFor(() => expect(screen.getByText('alice text')).toBeInTheDocument());
    expect(screen.getByText('bob text')).toBeInTheDocument();

    // ミュート → 該当投稿のみ除去（他ユーザーの投稿は残る）
    muteUser(alice);
    await waitFor(() => expect(screen.queryByText('alice text')).not.toBeInTheDocument());
    expect(screen.getByText('bob text')).toBeInTheDocument();
  });

  it('ミュート済みユーザーの投稿は初期表示から除去される（リロード後はサーバー側が返さない前提の補完）', async () => {
    const alice = makePost('p1', 'alice');
    const bob = makePost('p2', 'bob');
    vi.mocked(api.timeline).mockResolvedValue({ posts: [alice, bob], nextCursor: null });
    // 事前に非表示セットへ追加（セッション内ミラー）
    muteUser(alice);
    await vi.waitFor(() => expect(api.mute).toHaveBeenCalled());

    render(<TimelineCore sources={[{ provider: 'bluesky', kind: 'home' }]} />);
    await waitFor(() => expect(screen.getByText('bob text')).toBeInTheDocument());
    expect(screen.queryByText('alice text')).not.toBeInTheDocument();
  });
});
