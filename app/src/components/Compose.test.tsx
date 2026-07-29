import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    destinations: vi.fn(() => Promise.resolve([])),
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

beforeEach(() => {
  // destinations モックの既定（mockRejectedValue 等の持ち越しを防ぐ）
  vi.mocked(api.destinations).mockResolvedValue([]);
});

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

describe('Compose（Destination 選択。docs/compose-destination-spec.md）', () => {
  const CHANNELS = [
    {
      provider: 'misskey' as const,
      options: [
        { destination: { provider: 'misskey' as const, kind: 'home' as const }, name: 'ホーム' },
        { destination: { provider: 'misskey' as const, kind: 'channel' as const, id: 'C1' }, name: '📺 ゲーム部' },
      ],
    },
  ];

  it('ホーム候補は「{Provider} · ホーム」のフラットリストで、optgroup は無い（header-layout-spec §4）', async () => {
    vi.mocked(api.destinations).mockResolvedValue(CHANNELS);
    renderCompose();
    const select = (await screen.findByRole('combobox', { name: '投稿先' })) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'Misskey · ホーム' });
    expect(screen.getByRole('option', { name: 'Bluesky · ホーム' })).toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    // 閉じたセレクトの表示値がプレフィックス付きラベル（既定選択は bluesky home）
    expect(select.selectedOptions[0]?.textContent).toBe('Bluesky · ホーム');
  });

  it('カタログから候補を描画し、チャンネル選択で visibility が隠れて注記が出る', async () => {
    vi.mocked(api.destinations).mockResolvedValue(CHANNELS);
    const user = userEvent.setup();
    renderCompose();
    await screen.findByRole('option', { name: '📺 ゲーム部' });
    await user.selectOptions(screen.getByRole('combobox', { name: '投稿先' }), 'misskey:channel:C1');

    expect(screen.getByText('チャンネル投稿は公開・ローカルのみ（Misskey 仕様）')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('公開（public）')).not.toBeInTheDocument();
  });

  it('チャンネル投稿 → destination を送り、visibility/localOnly は送らない', async () => {
    vi.mocked(api.destinations).mockResolvedValue(CHANNELS);
    vi.mocked(api.post).mockResolvedValue({ ...POSTED, provider: 'misskey', id: 'n1' });
    const user = userEvent.setup();
    renderCompose();
    await screen.findByRole('option', { name: '📺 ゲーム部' });
    await user.selectOptions(screen.getByRole('combobox', { name: '投稿先' }), 'misskey:channel:C1');
    await user.type(screen.getByPlaceholderText(/MFM 使用可/), 'やあ');
    await user.click(screen.getByRole('button', { name: '投稿' }));

    await waitFor(() => {
      const input = vi.mocked(api.post).mock.calls[0][0];
      expect(input).toMatchObject({
        provider: 'misskey',
        destination: { provider: 'misskey', kind: 'channel', id: 'C1' },
      });
      expect(input.visibility).toBeUndefined();
      expect(input.localOnly).toBeUndefined();
    });
    // 前回選択が compose-destination に永続化される
    expect(JSON.parse(localStorage.getItem('compose-destination') ?? 'null')).toEqual({
      provider: 'misskey',
      kind: 'channel',
      id: 'C1',
    });
  });

  it('home 投稿 → destination.kind=home を送り、misskey なら visibility を維持する', async () => {
    vi.mocked(api.post).mockResolvedValue({ ...POSTED, provider: 'misskey', id: 'n2' });
    const user = userEvent.setup();
    renderCompose({ providers: MISSKEY_ONLY });
    await user.type(screen.getByPlaceholderText(/MFM 使用可/), 'やあ');
    await user.click(screen.getByRole('button', { name: '投稿' }));

    await waitFor(() =>
      expect(vi.mocked(api.post).mock.calls[0][0]).toMatchObject({
        provider: 'misskey',
        destination: { provider: 'misskey', kind: 'home' },
        visibility: 'public',
      }),
    );
  });

  it('チャンネルノートへの返信 → Destination がそのチャンネルに固定される', async () => {
    vi.mocked(api.post).mockResolvedValue({ ...POSTED, provider: 'misskey', id: 'n3' });
    const user = userEvent.setup();
    const replyTo: Post = {
      ...POSTED,
      provider: 'misskey',
      ref: 'note-1',
      channel: { id: 'C1', name: 'ゲーム部' },
    };
    renderCompose({ replyTo });

    expect(screen.getByText('📺 ゲーム部 へ投稿')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('返信を投稿'), 're');
    await user.click(screen.getByRole('button', { name: '投稿' }));

    await waitFor(() =>
      expect(vi.mocked(api.post).mock.calls[0][0]).toMatchObject({
        destination: { provider: 'misskey', kind: 'channel', id: 'C1' },
      }),
    );
  });

  it('カタログ取得失敗時も home 候補だけで動作する', async () => {
    vi.mocked(api.destinations).mockRejectedValue(new Error('boom'));
    renderCompose();
    // bsky+misskey の home 2候補（静的フォールバック）でセレクタ表示
    const select = await screen.findByRole('combobox', { name: '投稿先' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Bluesky · ホーム', 'Misskey · ホーム']);
  });

  it('nostr（configured だが compose 無し）は投稿先セレクタから除外される（§5.3）', async () => {
    const withNostr: ProviderInfo[] = [...BOTH, { provider: 'nostr', configured: true }];
    renderCompose({ providers: withNostr });
    const select = await screen.findByRole('combobox', { name: '投稿先' });
    const labels = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(labels).toEqual(['Bluesky · ホーム', 'Misskey · ホーム']);
    expect(labels.some((l) => l?.includes('Nostr'))).toBe(false);
  });
});
