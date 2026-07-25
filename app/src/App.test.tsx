import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { api } from './api';
import type { Post } from '../../shared/types';

vi.mock('./api', () => ({
  api: {
    health: vi.fn(),
    timeline: vi.fn(),
    uploadMedia: vi.fn(),
    post: vi.fn(),
  },
}));

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

beforeEach(() => {
  vi.mocked(api.timeline).mockResolvedValue({ posts: [], nextCursor: null });
});

describe('App の wiring', () => {
  it('初期状態：Timeline は表示・Compose は非表示', async () => {
    render(<App />);
    expect(await screen.findByText('SNS Client')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('いまどうしてる？')).not.toBeInTheDocument();
  });

  it('FAB で Compose が開き、閉じるボタンで閉じる', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('SNS Client');

    await user.click(screen.getByRole('button', { name: '投稿' }));
    expect(screen.getByPlaceholderText('いまどうしてる？')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByPlaceholderText('いまどうしてる？')).not.toBeInTheDocument();
  });

  it('返信で Compose が返信先バナー付きで開く', async () => {
    const user = userEvent.setup();
    vi.mocked(api.timeline).mockResolvedValue({ posts: [makePost()], nextCursor: null });
    render(<App />);
    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: '返信' }));
    expect(screen.getByPlaceholderText('返信を投稿')).toBeInTheDocument();
    expect(screen.getByText(/返信先: @alice\.bsky\.social/)).toBeInTheDocument();
  });

  it('引用で Compose が引用バナー付きで開く', async () => {
    const user = userEvent.setup();
    vi.mocked(api.timeline).mockResolvedValue({ posts: [makePost()], nextCursor: null });
    render(<App />);
    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: '引用' }));
    expect(screen.getByText(/引用: @alice\.bsky\.social/)).toBeInTheDocument();
  });
});
