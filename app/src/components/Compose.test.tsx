import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Compose } from './Compose';
import { api } from '../api';
import { MAX_GRAPHEMES } from '../lib/graphemes';
import type { Post } from '../../../shared/types';

vi.mock('../api', () => ({
  api: {
    health: vi.fn(),
    timeline: vi.fn(),
    uploadMedia: vi.fn(),
    post: vi.fn(),
  },
}));

const POSTED: Post = {
  id: 'p1',
  provider: 'bluesky',
  author: { handle: 'me.bsky.social', displayName: 'Me' },
  text: 'hello',
  createdAt: '2026-07-01T12:00:00Z',
  media: [],
  stats: { replies: 0, reposts: 0, likes: 0 },
  source: { uri: 'at://x', cid: 'c' },
};

function renderCompose(props: Partial<Parameters<typeof Compose>[0]> = {}) {
  return render(
    <Compose replyTo={undefined} quote={undefined} onClose={() => {}} onPosted={() => {}} {...props} />,
  );
}

function setTextarea(value: string): HTMLElement {
  const textarea = screen.getByPlaceholderText('いまどうしてる？');
  fireEvent.change(textarea, { target: { value } });
  return textarea;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Compose', () => {
  it('空のときは投稿ボタンが無効で、カウンターは上限値', () => {
    renderCompose();
    expect(screen.getByRole('button', { name: '投稿' })).toBeDisabled();
    expect(screen.getByText(String(MAX_GRAPHEMES))).toBeInTheDocument();
  });

  it('テキストを入力すると投稿ボタンが有効になり残りが減る', async () => {
    const user = userEvent.setup();
    renderCompose();
    await user.type(screen.getByPlaceholderText('いまどうしてる？'), 'hello');
    expect(screen.getByRole('button', { name: '投稿' })).toBeEnabled();
    expect(screen.getByText(String(MAX_GRAPHEMES - 5))).toBeInTheDocument();
  });

  it('残り 20 以下で warn クラスが付く', () => {
    renderCompose();
    setTextarea('a'.repeat(MAX_GRAPHEMES - 15)); // 残り 15
    expect(screen.getByText('15')).toHaveClass('warn');
  });

  it('上限超過で over クラス＋投稿ボタン無効', () => {
    renderCompose();
    setTextarea('a'.repeat(MAX_GRAPHEMES + 1)); // 301 → 残り -1
    expect(screen.getByText('-1')).toHaveClass('over');
    expect(screen.getByRole('button', { name: '投稿' })).toBeDisabled();
  });

  it('投稿失敗時に下書きを保持しエラーを表示する', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderCompose();
    const textarea = screen.getByPlaceholderText('いまどうしてる？');
    await user.type(textarea, 'hello');
    await user.click(screen.getByRole('button', { name: '投稿' }));

    expect(await screen.findByText(/送信失敗（下書きは保持）/)).toBeInTheDocument();
    expect(textarea).toHaveValue('hello'); // 下書きは消えない
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('投稿成功時に onPosted を呼び、下書きをリセットして onClose を呼ぶ', async () => {
    vi.mocked(api.post).mockResolvedValue(POSTED);
    const onClose = vi.fn();
    const onPosted = vi.fn();
    const user = userEvent.setup();
    renderCompose({ onClose, onPosted });
    const textarea = screen.getByPlaceholderText('いまどうしてる？');
    await user.type(textarea, 'hello');
    await user.click(screen.getByRole('button', { name: '投稿' }));

    await waitFor(() => expect(onPosted).toHaveBeenCalledWith(POSTED));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveValue(''); // 下書きリセット
  });
});
