import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { api } from './api';
import type { Post, ProviderInfo, View } from '../../shared/types';

vi.mock('./api', () => ({
  api: {
    health: vi.fn(),
    views: vi.fn(),
    providers: vi.fn(),
    timeline: vi.fn(),
    uploadMedia: vi.fn(),
    post: vi.fn(),
  },
}));

const VIEWS: View[] = [{ id: 'home', name: 'ホーム', sources: [{ provider: 'bluesky', kind: 'home' }] }];
const PROVIDERS: ProviderInfo[] = [
  { provider: 'bluesky', configured: true, compose: { charLimit: 300, unit: 'grapheme' } },
];

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
  vi.mocked(api.views).mockResolvedValue(VIEWS);
  vi.mocked(api.providers).mockResolvedValue(PROVIDERS);
  vi.mocked(api.timeline).mockResolvedValue({ posts: [], nextCursor: null });
});

describe('App の wiring', () => {
  it('初期状態：Timeline は表示・Compose は非表示', async () => {
    render(<App />);
    expect(await screen.findByText('ホーム')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('いまどうしてる？')).not.toBeInTheDocument();
  });

  it('views/providers 読込失敗でエラーバナーと再試行を出す', async () => {
    const user = userEvent.setup();
    vi.mocked(api.views).mockRejectedValueOnce(new Error('down'));
    render(<App />);
    expect(await screen.findByText(/設定の読み込みに失敗しました/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByText('ホーム')).toBeInTheDocument();
  });

  it('FAB で Compose が開き、閉じるボタンで閉じる', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('ホーム');

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
