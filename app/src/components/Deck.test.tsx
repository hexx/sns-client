import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Deck } from './Deck';
import { api } from '../api';
import type { SourceCatalogEntry, View } from '../../../shared/types';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      health: vi.fn(),
      views: vi.fn(),
      providers: vi.fn(),
      timeline: vi.fn(),
      uploadMedia: vi.fn(),
      post: vi.fn(),
      react: vi.fn(),
      emojis: vi.fn(),
      sources: vi.fn(),
      saveViews: vi.fn(),
    },
  };
});

const CATALOG: SourceCatalogEntry[] = [
  {
    provider: 'bluesky',
    options: [
      { source: { provider: 'bluesky', kind: 'home' }, name: 'ホーム' },
      { source: { provider: 'bluesky', kind: 'list', id: 'at://L1' }, name: 'AI' },
    ],
  },
  {
    provider: 'misskey',
    options: [
      { source: { provider: 'misskey', kind: 'home' }, name: 'ホーム' },
      { source: { provider: 'misskey', kind: 'list', id: 'mk-L1' }, name: '技術' },
      { source: { provider: 'misskey', kind: 'antenna', id: 'mk-A1' }, name: 'ニュース' },
      { source: { provider: 'misskey', kind: 'channel', id: 'mk-C1' }, name: '📺 ゲーム部' },
    ],
  },
];

const VIEWS: View[] = [
  { id: 'v1', name: 'ホーム', sources: [{ provider: 'bluesky', kind: 'home' }] },
  { id: 'v2', name: '技術', sources: [{ provider: 'misskey', kind: 'list', id: 'mk-L1' }] },
];

beforeEach(() => {
  vi.mocked(api.timeline).mockResolvedValue({ posts: [], nextCursor: null });
  vi.mocked(api.sources).mockResolvedValue(CATALOG);
});

describe('Deck（カラム描画）', () => {
  it('View ごとにカラムを描画する', () => {
    render(<Deck views={VIEWS} onViewsChange={() => {}} onCompose={() => {}} />);
    expect(screen.getByRole('region', { name: 'ホーム' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '技術' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ カラム追加' })).toBeInTheDocument();
  });

  it('新規投稿 FAB で onCompose が呼ばれる', async () => {
    const user = userEvent.setup();
    const onCompose = vi.fn();
    render(<Deck views={VIEWS} onViewsChange={() => {}} onCompose={onCompose} />);

    await user.click(screen.getByRole('button', { name: '新規投稿' }));
    expect(onCompose).toHaveBeenCalledTimes(1);
  });
});

describe('Deck（カラム追加）', () => {
  it('カタログから Source を選んで追加すると onViewsChange に乗る', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Deck views={VIEWS} onViewsChange={onChange} onCompose={() => {}} />);

    await user.click(screen.getByRole('button', { name: '+ カラム追加' }));
    // ダイアログが開きカタログが取得される
    await waitFor(() => expect(api.sources).toHaveBeenCalled());
    expect(await screen.findByText('ニュース')).toBeInTheDocument();

    // 名前を入力し、Misskey のリスト＋アンテナを選択
    await user.clear(screen.getByRole('textbox', { name: 'カラム名' }));
    await user.type(screen.getByRole('textbox', { name: 'カラム名' }), 'まとめ');
    const tech = screen.getByRole('checkbox', { name: /技術/ });
    const news = screen.getByRole('checkbox', { name: /ニュース/ });
    await user.click(tech);
    await user.click(news);
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as View[];
    expect(next).toHaveLength(3);
    expect(next[2].name).toBe('まとめ');
    expect(next[2].sources).toEqual([
      { provider: 'misskey', kind: 'list', id: 'mk-L1' },
      { provider: 'misskey', kind: 'antenna', id: 'mk-A1' },
    ]);
  });

  it('お気に入りチャンネルを 📺 プレフィックス付きで選択・保存できる（docs/misskey-channel-source-spec.md）', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Deck views={VIEWS} onViewsChange={onChange} onCompose={() => {}} />);

    await user.click(screen.getByRole('button', { name: '+ カラム追加' }));
    await waitFor(() => expect(api.sources).toHaveBeenCalled());

    const ch = await screen.findByRole('checkbox', { name: /📺 ゲーム部/ });
    await user.clear(screen.getByRole('textbox', { name: 'カラム名' }));
    await user.type(screen.getByRole('textbox', { name: 'カラム名' }), 'ゲーム');
    await user.click(ch);
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as View[];
    expect(next[2].sources).toEqual([{ provider: 'misskey', kind: 'channel', id: 'mk-C1' }]);
  });

  it('Source 未選択では保存できない', async () => {
    const user = userEvent.setup();
    render(<Deck views={VIEWS} onViewsChange={() => {}} onCompose={() => {}} />);
    await user.click(screen.getByRole('button', { name: '+ カラム追加' }));
    await waitFor(() => expect(api.sources).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });
});

describe('Deck（削除・並び替え・編集）', () => {
  it('削除確認を経て onViewsChange から当該 View が消える', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Deck views={VIEWS} onViewsChange={onChange} onCompose={() => {}} />);

    const delButtons = screen.getAllByRole('button', { name: '削除' });
    await user.click(delButtons[0]); // v1 の ✕
    // 確認ダイアログの確定ボタン（カラムヘッダーの ✕ と同名のため class で特定）
    const confirm = document.querySelector('.modal .primary-btn') as HTMLButtonElement;
    expect(confirm.textContent).toBe('削除');
    await user.click(confirm);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0][0] as View[]).map((v) => v.id)).toEqual(['v2']);
  });

  it('左右矢印で並び替える', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Deck views={VIEWS} onViewsChange={onChange} onCompose={() => {}} />);

    const rightButtons = screen.getAllByRole('button', { name: '右へ移動' });
    await user.click(rightButtons[0]); // v1 を右へ
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as View[];
    expect(next.map((v) => v.id)).toEqual(['v2', 'v1']);
  });

  it('端のカラムはそれ以上移動できない', () => {
    render(<Deck views={VIEWS} onViewsChange={() => {}} onCompose={() => {}} />);
    expect(screen.getAllByRole('button', { name: '左へ移動' })[0]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: '右へ移動' })[1]).toBeDisabled();
  });

  it('編集ダイアログで名前を変えると onViewsChange に反映される', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Deck views={VIEWS} onViewsChange={onChange} onCompose={() => {}} />);

    await user.click(screen.getAllByRole('button', { name: '編集' })[1]); // v2 の ⚙
    const nameInput = await screen.findByRole('textbox', { name: 'カラム名' });
    await user.clear(nameInput);
    await user.type(nameInput, 'テック');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as View[];
    expect(next[1].name).toBe('テック');
    // 既存の選択ソースは維持（カタログの同名項目がチェック済みで再構成される）
    expect(next[1].sources).toEqual([{ provider: 'misskey', kind: 'list', id: 'mk-L1' }]);
  });
});
