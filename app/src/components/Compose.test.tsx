import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Compose } from './Compose';
import { api } from '../api';
import { MAX_GRAPHEMES } from '../lib/graphemes';
import type { Post, ProviderInfo } from '../../../shared/types';

vi.mock('../api', () => ({
  api: {
    health: vi.fn(),
    views: vi.fn(),
    providers: vi.fn(),
    timeline: vi.fn(),
    uploadMedia: vi.fn(),
    post: vi.fn(),
  },
}));

const BOTH: ProviderInfo[] = [
  { provider: 'bluesky', configured: true, compose: { charLimit: 300, unit: 'grapheme' } },
  { provider: 'misskey', configured: true, compose: { charLimit: 3000, unit: 'char' } },
];
const MISSKEY_ONLY: ProviderInfo[] = [
  { provider: 'misskey', configured: true, compose: { charLimit: 3000, unit: 'char' } },
];

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
    <Compose providers={BOTH} replyTo={undefined} quote={undefined} onClose={() => {}} onPosted={() => {}} {...props} />,
  );
}

function setTextarea(value: string): HTMLElement {
  const textarea = screen.getByPlaceholderText('いまどうしてる？');
  fireEvent.change(textarea, { target: { value } });
  return textarea;
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Compose（Bluesky ターゲット）', () => {
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

  it('上限超過で over クラス＋投稿ボタン無効', () => {
    renderCompose();
    setTextarea('a'.repeat(MAX_GRAPHEMES + 1));
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
    expect(textarea).toHaveValue('hello');
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('投稿成功時に provider=bluesky を送り、onPosted/onClose を呼ぶ', async () => {
    vi.mocked(api.post).mockResolvedValue(POSTED);
    const onClose = vi.fn();
    const onPosted = vi.fn();
    const user = userEvent.setup();
    renderCompose({ onClose, onPosted });
    await user.type(screen.getByPlaceholderText('いまどうしてる？'), 'hello');
    await user.click(screen.getByRole('button', { name: '投稿' }));

    await waitFor(() => expect(onPosted).toHaveBeenCalledWith(POSTED));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.post).mock.calls[0][0]).toMatchObject({ provider: 'bluesky', text: 'hello' });
  });

  it('返信時は Post.ref を replyTo としてエコーする（source ではなく）', async () => {
    vi.mocked(api.post).mockResolvedValue(POSTED);
    const user = userEvent.setup();
    const replyTo: Post = { ...POSTED, ref: { uri: 'at://r', cid: 'cr' } };
    renderCompose({ replyTo });
    await user.type(screen.getByPlaceholderText('返信を投稿'), 're');
    await user.click(screen.getByRole('button', { name: '投稿' }));

    await waitFor(() =>
      expect(vi.mocked(api.post).mock.calls[0][0]).toMatchObject({ replyTo: { uri: 'at://r', cid: 'cr' } }),
    );
  });
});

describe('Compose（Misskey ターゲット）', () => {
  it('misskey のみ設定 → 文字数カウンタ（3000）＋ visibility セレクタ表示', () => {
    renderCompose({ providers: MISSKEY_ONLY });
    expect(screen.getByText('3000')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/MFM 使用可/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('公開（public）')).toBeInTheDocument();
    expect(screen.getByText('ローカルのみ')).toBeInTheDocument();
  });

  it('misskey 投稿 → provider=misskey と visibility を送る', async () => {
    vi.mocked(api.post).mockResolvedValue({ ...POSTED, provider: 'misskey', id: 'n1' });
    const user = userEvent.setup();
    renderCompose({ providers: MISSKEY_ONLY });
    await user.type(screen.getByPlaceholderText(/MFM 使用可/), ':kawaii: やあ');
    await user.click(screen.getByRole('button', { name: '投稿' }));

    await waitFor(() =>
      expect(vi.mocked(api.post).mock.calls[0][0]).toMatchObject({ provider: 'misskey', visibility: 'public' }),
    );
  });
});
