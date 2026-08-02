import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { PostCard } from './PostCard';
import { resetEmojiCache } from './ReactionPicker';
import { api } from '../api';
import type { Media, Post } from '../../../shared/types';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, emojis: vi.fn() } };
});

// ブロック・ミュート（docs/block-mute-spec.md §5）：アクション関数と自分の投稿判定を制御可能にする
const mod = vi.hoisted(() => ({
  muteUser: vi.fn(),
  blockUser: vi.fn(),
  isOwnPost: vi.fn().mockResolvedValue(false),
}));
vi.mock('../lib/moderation', () => ({
  muteUser: mod.muteUser,
  blockUser: mod.blockUser,
  isOwnPost: mod.isOwnPost,
  isHiddenPost: () => false,
  subscribeHidden: () => () => {},
  subscribeModerationToasts: () => () => {},
  loadMe: vi.fn().mockResolvedValue(null),
  resetModerationForTests: () => {},
}));

const NOW = new Date('2026-07-01T12:00:00Z');

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    provider: 'bluesky',
    author: {
      id: 'did:plc:alice',
      handle: 'alice.bsky.social',
      displayName: 'Alice',
      avatarUrl: 'https://example.com/a.png',
    },
    text: 'こんにちは世界',
    createdAt: NOW.toISOString(),
    media: [],
    stats: { replies: 1, reposts: 2, likes: 3 },
    source: { uri: 'at://x', cid: 'c' },
    ...overrides,
  };
}

function isoAgo(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PostCard', () => {
  it('著者名・ハンドル・本文・統計を描画する', () => {
    render(<PostCard post={makePost()} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('@alice.bsky.social')).toBeInTheDocument();
    expect(screen.getByText('こんにちは世界')).toBeInTheDocument();
    expect(screen.getByTitle('リプライ')).toHaveTextContent('1');
    expect(screen.getByTitle('リポスト')).toHaveTextContent('2');
    expect(screen.getByTitle('いいね')).toHaveTextContent('3');
  });

  it('onReply / onQuote が渡されたときだけボタンを描画する', () => {
    const { rerender } = render(<PostCard post={makePost()} />);
    expect(screen.queryByRole('button', { name: '返信' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '引用' })).not.toBeInTheDocument();

    rerender(<PostCard post={makePost()} onReply={() => {}} onQuote={() => {}} />);
    expect(screen.getByRole('button', { name: '返信' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '引用' })).toBeInTheDocument();
  });

  it('空 URL のメディアは除外し、有効なものだけ描画する', () => {
    const post = makePost({
      media: [
        { type: 'image', url: 'https://example.com/1.png', alt: 'one' },
        { type: 'image', url: '' }, // 空 URL は除外される
      ],
    });
    const { container } = render(<PostCard post={post} />);
    // .media 内の img は 1 枚のみ（空 URL のメディアは filter で除外される）
    // ※アバターは alt="" の装飾画像のため role=img で数えない
    expect(container.querySelectorAll('.media img')).toHaveLength(1);
    expect(screen.getByAltText('one')).toBeInTheDocument();
  });

  it('アバターが無いときはフォールバックを描画する', () => {
    const post = makePost({ author: { id: 'did:plc:bob', handle: 'b.bsky.social', displayName: 'Bob' } });
    const { container } = render(<PostCard post={post} />);
    expect(container.querySelector('.avatar-fallback')).toBeInTheDocument();
  });
});

describe('LinkCard', () => {
  const linkCard = {
    url: 'https://example.com/article?x=1',
    title: '記事タイトル',
    description: '記事の説明',
    thumbUrl: 'https://cardyb.bsky.app/v1/extract/x',
  };

  it('タイトル・説明・ホスト名・リンク属性を描画する', () => {
    const { container } = render(<PostCard post={makePost({ linkCard })} />);
    const anchor = screen.getByRole('link', { name: /記事タイトル/ });
    expect(anchor).toHaveAttribute('href', 'https://example.com/article?x=1');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('記事タイトル')).toBeInTheDocument();
    expect(screen.getByText('記事の説明')).toBeInTheDocument();
    const thumb = container.querySelector('.link-card-thumb');
    expect(thumb).toBeInTheDocument();
    expect(thumb).toHaveAttribute('src', linkCard.thumbUrl);
  });

  it('タイトル空 → ホスト名をタイトルとして表示する', () => {
    render(
      <PostCard
        post={makePost({ linkCard: { url: 'https://example.com/', title: '', description: '' } })}
      />,
    );
    // ホスト名が host 行とタイトル行の両方に出る
    expect(screen.getAllByText('example.com').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('記事の説明')).not.toBeInTheDocument();
  });

  it('thumbUrl 無し → サムネイルを描画しない', () => {
    const { container } = render(
      <PostCard
        post={makePost({
          linkCard: { url: 'https://example.com/', title: 't', description: 'd' },
        })}
      />,
    );
    expect(container.querySelector('.link-card')).toBeInTheDocument();
    expect(container.querySelector('.link-card-thumb')).not.toBeInTheDocument();
  });

  it('linkCard 無し → カード要素を描画しない', () => {
    const { container } = render(<PostCard post={makePost()} />);
    expect(container.querySelector('.link-card')).not.toBeInTheDocument();
  });
});

describe('relTime（相対時刻）', () => {
  it('不正な日付は「たった今」', () => {
    render(<PostCard post={makePost({ createdAt: 'not-a-date' })} />);
    expect(screen.getByText('たった今')).toBeInTheDocument();
  });

  it('30 秒前 → 「30秒」', () => {
    render(<PostCard post={makePost({ createdAt: isoAgo(30 * 1000) })} />);
    expect(screen.getByText('30秒')).toBeInTheDocument();
  });

  it('5 分前 → 「5分」', () => {
    render(<PostCard post={makePost({ createdAt: isoAgo(5 * 60 * 1000) })} />);
    expect(screen.getByText('5分')).toBeInTheDocument();
  });

  it('3 時間前 → 「3時間」', () => {
    render(<PostCard post={makePost({ createdAt: isoAgo(3 * 60 * 60 * 1000) })} />);
    expect(screen.getByText('3時間')).toBeInTheDocument();
  });

  it('2 日前 → 「2日」', () => {
    render(<PostCard post={makePost({ createdAt: isoAgo(2 * 24 * 60 * 60 * 1000) })} />);
    expect(screen.getByText('2日')).toBeInTheDocument();
  });
});

describe('リッチ表示（Misskey 統合）', () => {
  it('rich セグメントを描画する（リンク/メンション/ハッシュタグ/カスタム絵文字）', () => {
    const { container } = render(
      <PostCard
        post={makePost({
          text: 'plain fallback',
          rich: [
            { type: 'text', text: 'see ' },
            { type: 'link', url: 'https://x.y', text: 'site' },
            { type: 'text', text: ' ' },
            { type: 'mention', handle: 'bob' },
            { type: 'text', text: ' ' },
            { type: 'hashtag', tag: 'tag' },
            { type: 'text', text: ' ' },
            { type: 'emoji', name: 'kawaii', url: 'https://e/kawaii.png' },
          ],
        })}
      />,
    );
    const link = screen.getByRole('link', { name: 'site' });
    expect(link).toHaveAttribute('href', 'https://x.y');
    expect(screen.getByText('@bob')).toBeInTheDocument();
    expect(screen.getByText('#tag')).toBeInTheDocument();
    const emoji = container.querySelector('.rt-emoji') as HTMLImageElement;
    expect(emoji).toHaveAttribute('src', 'https://e/kawaii.png');
    // rich 優先（プレーンフォールバックは出ない）
    expect(screen.queryByText('plain fallback')).not.toBeInTheDocument();
  });

  it('reactions チップを描画し、❤️総数は省略する', () => {
    const { container } = render(
      <PostCard
        post={makePost({
          stats: { replies: 0, reposts: 0, likes: 7 },
          reactions: [
            { emoji: ':kawaii:', count: 5, emojiUrl: 'https://e/kawaii.png', me: true },
            { emoji: '👍', count: 2 },
          ],
        })}
      />,
    );
    const chips = container.querySelectorAll('.reaction');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveClass('me');
    expect(container.querySelector('.reaction-emoji')).toHaveAttribute('src', 'https://e/kawaii.png');
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.queryByTitle('いいね')).not.toBeInTheDocument(); // reactions 有りで省略
  });

  it('repostedBy バッジを描画する', () => {
    render(
      <PostCard
        post={makePost({ repostedBy: { id: 'u-carol', handle: 'carol', displayName: 'Carol' } })}
      />,
    );
    // 名前は DisplayName（span）に分割されるため textContent で検証する
    expect(document.querySelector('.repost-badge')?.textContent).toContain('Carol がリポスト');
  });

  it('引用カード（1階層）を描画する', () => {
    const quote: Post = {
      ...makePost({ id: 'q1', author: { id: 'u-quoted', handle: 'quoted', displayName: 'Quoted' }, text: 'quoted body' }),
    };
    render(<PostCard post={makePost({ text: 'my comment', quote })} />);
    expect(screen.getByText('my comment')).toBeInTheDocument();
    const quoteCard = screen.getByText('quoted body').closest('.quote-card');
    expect(quoteCard).toBeInTheDocument();
    expect(quoteCard).toHaveTextContent('Quoted');
  });

  it('非 public / localOnly に visibility バッジを描画する（アイコンのみ・テキスト無し。docs/card-meta-row-spec.md §4）', () => {
    render(<PostCard post={makePost({ visibility: 'followers', localOnly: true })} />);
    // 🔒+📍 の合成、ツールチップも合成。テキスト「ローカルのみ」は出ない
    const badge = screen.getByTitle('ローカルのみ・followers');
    expect(badge).toHaveTextContent('🔒📍');
    expect(badge).not.toHaveTextContent('ローカルのみ');
  });
});

describe('リアクション操作（Misskey、docs/misskey-reaction-action-spec.md）', () => {
  function mkPost(overrides: Partial<Post> = {}): Post {
    return makePost({ provider: 'misskey', ref: 'n1', ...overrides });
  }

  beforeEach(() => {
    vi.useRealTimers(); // userEvent は fake timers と相性が悪いため、このブロックだけ実タイマーにする
    resetEmojiCache();
    vi.mocked(api.emojis).mockResolvedValue([{ name: 'kawaii', url: 'https://e/kawaii.png', aliases: ['kw'] }]);
  });

  it('Misskey＋onReact 有り: チップはボタン化し「＋」を描画する', () => {
    const { container } = render(
      <PostCard post={mkPost({ reactions: [{ emoji: '👍', count: 2 }] })} onReact={() => {}} />,
    );
    expect(container.querySelectorAll('button.reaction')).toHaveLength(2); // チップ1＋「＋」
    expect(screen.getByRole('button', { name: 'リアクションを追加' })).toBeInTheDocument();
  });

  it('reactions 無しでも Misskey なら「＋」を描画する', () => {
    render(<PostCard post={mkPost()} onReact={() => {}} />);
    expect(screen.getByRole('button', { name: 'リアクションを追加' })).toBeInTheDocument();
  });

  it('他人のチップクリック → 付与（onReact(post, emoji, url)）', async () => {
    const onReact = vi.fn();
    render(<PostCard post={mkPost({ reactions: [{ emoji: '👍', count: 2 }] })} onReact={onReact} />);
    await userEvent.click(screen.getByTitle('👍'));
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), '👍', undefined);
  });

  it('自分のチップ（me）クリック → 解除（onReact(post)）', async () => {
    const onReact = vi.fn();
    render(
      <PostCard post={mkPost({ reactions: [{ emoji: ':kawaii:', count: 1, me: true, emojiUrl: 'u' }] })} onReact={onReact} />,
    );
    await userEvent.click(screen.getByTitle(':kawaii:'));
    expect(onReact).toHaveBeenCalledTimes(1);
    expect(onReact.mock.calls[0]).toHaveLength(1); // 解除は reaction 引数無し
    expect(onReact.mock.calls[0][0]).toEqual(expect.objectContaining({ id: 'p1' }));
  });

  it('ピッカーからカスタム絵文字を選ぶ → 付与（:name: と url）', async () => {
    const onReact = vi.fn();
    render(<PostCard post={mkPost()} onReact={onReact} />);
    await userEvent.click(screen.getByRole('button', { name: 'リアクションを追加' }));
    await waitFor(() => expect(screen.getByTitle(':kawaii:')).toBeInTheDocument());
    await userEvent.click(screen.getByTitle(':kawaii:'));
    expect(onReact).toHaveBeenCalledWith(expect.anything(), ':kawaii:', 'https://e/kawaii.png');
  });

  it('ピッカーの Unicode パレットから選ぶ → 付与（文字のみ）', async () => {
    const onReact = vi.fn();
    render(<PostCard post={mkPost()} onReact={onReact} />);
    await userEvent.click(screen.getByRole('button', { name: 'リアクションを追加' }));
    await userEvent.click(screen.getByTitle('👍'));
    expect(onReact).toHaveBeenCalledWith(expect.anything(), '👍', undefined);
  });

  it('Bluesky 投稿には反応 UI を一切描画しない（onReact 有りでも）', () => {
    const { container } = render(
      <PostCard post={makePost({ reactions: [{ emoji: '👍', count: 1 }] })} onReact={() => {}} />,
    );
    expect(container.querySelectorAll('button.reaction')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'リアクションを追加' })).not.toBeInTheDocument();
  });

  it('onReact 無しの Misskey 投稿は表示のみ（ボタン化しない）', () => {
    const { container } = render(<PostCard post={mkPost({ reactions: [{ emoji: '👍', count: 1 }] })} />);
    expect(container.querySelectorAll('button.reaction')).toHaveLength(0);
    expect(container.querySelectorAll('.reaction')).toHaveLength(1); // span チップ
  });
});

describe('チャンネルチップ（Misskey、docs/misskey-channel-display-spec.md）', () => {
  it('channel 有り → 時刻の隣に名前・title 属性付きで描画する', () => {
    const { container } = render(
      <PostCard post={makePost({ channel: { id: 'chX', name: 'ゲーム部' } })} />,
    );
    const chip = container.querySelector('.channel-chip');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute('title', 'ゲーム部');
    expect(chip).toHaveTextContent('📺');
    expect(chip).toHaveTextContent('ゲーム部');
  });

  it('channel 無し → チップ要素を描画しない', () => {
    const { container } = render(<PostCard post={makePost()} />);
    expect(container.querySelector('.channel-chip')).not.toBeInTheDocument();
  });

  it('repostedBy 有り＋channel 有り → チップを描画する（外部renoteの回帰）', () => {
    const { container } = render(
      <PostCard
        post={makePost({
          repostedBy: { id: 'u-carol', handle: 'carol', displayName: 'Carol' },
          channel: { id: 'chX', name: 'ゲーム部' },
        })}
      />,
    );
    expect(container.querySelector('.repost-badge')?.textContent).toContain('Carol がリポスト');
    expect(container.querySelector('.channel-chip')).toHaveTextContent('ゲーム部');
  });

  it('quote.channel 有り → QuoteCard 内にはチップを描画しない', () => {
    const quote: Post = {
      ...makePost({ id: 'q1', text: 'quoted body', channel: { id: 'chY', name: '音楽部' } }),
    };
    const { container } = render(<PostCard post={makePost({ text: 'comment', quote })} />);
    const quoteCard = container.querySelector('.quote-card');
    expect(quoteCard).toBeInTheDocument();
    expect(quoteCard?.querySelector('.channel-chip')).not.toBeInTheDocument();
  });
});

describe('PostCard の操作ボタン（docs/deck-view-spec.md §6）', () => {
  it('onLike/onRepost 無し → stats はテキストのまま', () => {
    render(<PostCard post={makePost()} />);
    expect(screen.queryByRole('button', { name: /❤️/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /🔁/ })).not.toBeInTheDocument();
  });

  it('Bluesky: onLike 有り → いいねボタンになり、クリックで発火', () => {
    const onLike = vi.fn();
    const post = makePost({ ref: { uri: 'at://p1', cid: 'c1' } });
    render(<PostCard post={post} onLike={onLike} />);
    fireEvent.click(screen.getByRole('button', { name: /❤️ 3/ }));
    expect(onLike).toHaveBeenCalledWith(post);
  });

  it('Bluesky: viewer.likeUri 有り → active クラス', () => {
    render(
      <PostCard
        post={makePost({ viewer: { likeUri: 'at://like/1' } })}
        onLike={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /❤️/ }).className).toContain('active');
  });

  it('Misskey: onRepost 有り → リノートボタン（いいねボタンは出ない）', () => {
    const onRepost = vi.fn();
    const post = makePost({ provider: 'misskey', ref: 'note-1' });
    render(<PostCard post={post} onLike={() => {}} onRepost={onRepost} />);
    expect(screen.queryByRole('button', { name: /❤️/ })).not.toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /🔁 2/ });
    expect(btn).toHaveAttribute('title', 'リノート');
    fireEvent.click(btn);
    expect(onRepost).toHaveBeenCalledWith(post);
  });

  it('帰属バッジを描画する', () => {
    render(<PostCard post={makePost()} badge="Misskey · 技術リスト" />);
    expect(screen.getByText('Misskey · 技術リスト')).toBeInTheDocument();
  });
});

function openLightboxAt(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

/** Lightbox のクローズは 150ms フェード後にアンマウントする（fake timers を進める） */
function closeLightboxAndWait() {
  act(() => {
    vi.advanceTimersByTime(200);
  });
}

describe('Lightbox（投稿画像の拡大表示、docs/lightbox-spec.md）', () => {
  const fourMedia: Media[] = [
    { type: 'image', url: 'https://example.com/1.png', alt: 'one' },
    { type: 'image', url: 'https://example.com/2.png', alt: 'two' },
    { type: 'image', url: 'https://example.com/3.png' },
    { type: 'image', url: 'https://example.com/4.png', alt: 'four' },
  ];

  it('サムネイルクリックで aria 属性付きのダイアログが開く', () => {
    render(<PostCard post={makePost({ media: fourMedia })} />);
    openLightboxAt('one');
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', '画像の拡大表示');
  });

  it('クリックした画像を1枚目として開き、位置表示を出す。←/→で切替', () => {
    render(<PostCard post={makePost({ media: fourMedia })} />);
    openLightboxAt('two');
    expect(screen.getByText('2 / 4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '次の画像' }));
    expect(screen.getByText('3 / 4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '前の画像' }));
    expect(screen.getByText('2 / 4')).toBeInTheDocument();
  });

  it('端では ←/→ が無効で循環しない。矢印キーでも切替', () => {
    render(<PostCard post={makePost({ media: fourMedia })} />);
    openLightboxAt('one');
    expect(screen.getByRole('button', { name: '前の画像' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('2 / 4')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('4 / 4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '次の画像' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'ArrowRight' }); // 循環しない
    expect(screen.getByText('4 / 4')).toBeInTheDocument();
  });

  it('左スワイプ（水平 50px 以上）で次の画像へ切替', () => {
    render(<PostCard post={makePost({ media: fourMedia })} />);
    openLightboxAt('one');
    const dialog = screen.getByRole('dialog');
    fireEvent.touchStart(dialog, { touches: [{ clientX: 300, clientY: 100 }] });
    fireEvent.touchEnd(dialog, { changedTouches: [{ clientX: 200, clientY: 105 }] });
    expect(screen.getByText('2 / 4')).toBeInTheDocument();
  });

  it('画像1枚の投稿では ←/→ も位置表示も出ない', () => {
    render(
      <PostCard
        post={makePost({ media: [{ type: 'image', url: 'https://example.com/solo.png', alt: 'solo' }] })}
      />,
    );
    openLightboxAt('solo');
    expect(screen.queryByRole('button', { name: '前の画像' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '次の画像' })).not.toBeInTheDocument();
    expect(screen.queryByText('1 / 1')).not.toBeInTheDocument();
  });

  it('alt は画像下に表示。alt がなければ要素自体がない', () => {
    const { container } = render(<PostCard post={makePost({ media: fourMedia })} />);
    openLightboxAt('one');
    expect(container.querySelector('.lightbox-alt')).toHaveTextContent('one');
    fireEvent.click(screen.getByRole('button', { name: '次の画像' }));
    fireEvent.click(screen.getByRole('button', { name: '次の画像' }));
    // 3枚目は alt なし
    expect(container.querySelector('.lightbox-alt')).not.toBeInTheDocument();
  });

  it('×・Esc・背景クリック・画像クリックのそれぞれで閉じる', () => {
    render(<PostCard post={makePost({ media: fourMedia })} />);
    // ×
    openLightboxAt('one');
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    closeLightboxAndWait();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Esc
    openLightboxAt('one');
    fireEvent.keyDown(window, { key: 'Escape' });
    closeLightboxAndWait();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // 背景クリック
    openLightboxAt('one');
    fireEvent.click(screen.getByRole('dialog'));
    closeLightboxAndWait();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // 画像クリック（サムネと区別するためダイアログ内にスコープ）
    openLightboxAt('one');
    fireEvent.click(within(screen.getByRole('dialog')).getByAltText('one'));
    closeLightboxAndWait();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('開いたとき × にフォーカスし、閉じたら開き元サムネイルに返す。スクロールロックも復元', () => {
    render(<PostCard post={makePost({ media: fourMedia })} />);
    const thumb = screen.getByRole('button', { name: 'two' });
    thumb.focus();
    fireEvent.click(thumb);
    expect(screen.getByRole('button', { name: '閉じる' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    closeLightboxAndWait();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
    expect(thumb).toHaveFocus();
  });

  it('Tab は Lightbox 内で循環する（フォーカストラップ）', () => {
    render(<PostCard post={makePost({ media: fourMedia })} />);
    openLightboxAt('one');
    // 1枚目では prev 無効 → フォーカス可能は [閉じる, 次の画像]
    const close = screen.getByRole('button', { name: '閉じる' });
    const next = screen.getByRole('button', { name: '次の画像' });
    const dialog = screen.getByRole('dialog');
    next.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(next).toHaveFocus();
  });

  it('読込失敗時はメッセージ + alt + 再試行ボタン。再試行で再読込', () => {
    render(<PostCard post={makePost({ media: fourMedia })} />);
    openLightboxAt('one');
    const dialog = screen.getByRole('dialog');
    fireEvent.error(within(dialog).getByAltText('one'));
    expect(screen.getByText('画像を読み込めませんでした')).toBeInTheDocument();
    expect(screen.getByText('one')).toBeInTheDocument(); // エラーブロック内の alt
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(screen.queryByText('画像を読み込めませんでした')).not.toBeInTheDocument();
    expect(within(dialog).getByAltText('one')).toBeInTheDocument(); // img 再マウント
  });
});

describe('表示名（docs/name-display-spec.md）', () => {
  it('displayNameRich があれば絵文字を画像で描画し、title にフルネームを持つ', () => {
    const { container } = render(
      <PostCard
        post={makePost({
          author: {
            id: 'u-shizuku',
            handle: 'shizuku@misskey.io',
            displayName: '応彩しずく :verified_blue:',
            displayNameRich: [
              { type: 'text', text: '応彩しずく ' },
              { type: 'emoji', name: 'verified_blue', url: 'https://e/vb.png' },
            ],
          },
        })}
      />,
    );
    const img = container.querySelector('.display-name img.rt-emoji') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe('https://e/vb.png');
    expect(container.querySelector('.display-name')).toHaveAttribute('title', '応彩しずく :verified_blue:');
  });

  it('displayNameRich がなければプレーンテキスト描画', () => {
    render(<PostCard post={makePost()} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('repostedBy バッジの名前も絵文字解決される', () => {
    const { container } = render(
      <PostCard
        post={makePost({
          repostedBy: {
            id: 'u-carol',
            handle: 'carol',
            displayName: 'Carol :kawaii:',
            displayNameRich: [
              { type: 'text', text: 'Carol ' },
              { type: 'emoji', name: 'kawaii', url: 'https://e/k.png' },
            ],
          },
        })}
      />,
    );
    expect(container.querySelector('.repost-badge img.rt-emoji')).not.toBeNull();
  });

  it('2行ヘッダー: 時刻は名前行（author-line-main）、チップはメタ行（author-line-meta）', () => {
    const { container } = render(
      <PostCard
        post={makePost({ channel: { id: 'ch1', name: '音楽部' } })}
        badge="Misskey · 技術"
      />,
    );
    const main = container.querySelector('.author-line-main');
    const meta = container.querySelector('.author-line-meta');
    const attr = container.querySelector('.author-line-attr');
    expect(main?.querySelector('.display-name')).not.toBeNull();
    expect(main?.querySelector('time.time')).not.toBeNull();
    // 2行目=投稿者情報、3行目=帰属情報（docs/card-meta-row-spec.md §3）
    expect(meta?.querySelector('.handle')).not.toBeNull();
    expect(meta?.querySelector('.channel-chip')).toBeNull();
    expect(attr?.querySelector('.channel-chip')).not.toBeNull();
    expect(attr?.querySelector('.provider-badge')).not.toBeNull();
  });
});

describe('引用カード（docs/quote-display-spec.md）', () => {
  function makeQuote(overrides: Partial<Post> = {}): Post {
    return {
      id: 'q1',
      provider: 'bluesky',
      author: { id: 'did:plc:q', handle: 'q.bsky.social', displayName: 'Q', avatarUrl: 'https://example.com/q.png' },
      text: '引用される本文',
      createdAt: NOW.toISOString(),
      media: [],
      stats: { replies: 4, reposts: 5, likes: 6 },
      url: 'https://bsky.app/profile/did:plc:q/post/q1',
      source: { uri: 'at://q', cid: 'cq' },
      ...overrides,
    };
  }

  it('quote があると引用カードを描画し、本文は5行截断クラス付き', () => {
    render(<PostCard post={makePost({ quote: makeQuote() })} />);
    expect(screen.getByText('引用される本文')).toBeInTheDocument();
    expect(screen.getByText('もっと見る')).toBeInTheDocument();
    const clamp = document.querySelector('.quote-body-clamp');
    expect(clamp).not.toBeNull();
  });

  it('「もっと見る」で展開 → stats・日時・外部リンクが表示され截断が外れる', () => {
    render(<PostCard post={makePost({ quote: makeQuote() })} />);
    expect(document.querySelector('.quote-meta')).toBeNull();
    fireEvent.click(screen.getByText('もっと見る'));
    const meta = document.querySelector('.quote-meta');
    expect(meta).not.toBeNull();
    expect(within(meta as HTMLElement).getByText('❤️ 6')).toBeInTheDocument();
    const link = document.querySelector('.quote-ext-link') as HTMLAnchorElement;
    expect(link.href).toBe('https://bsky.app/profile/did:plc:q/post/q1');
    expect(link.target).toBe('_blank');
    expect(document.querySelector('.quote-body-clamp')).toBeNull();
    fireEvent.click(screen.getByText('閉じる'));
    expect(document.querySelector('.quote-meta')).toBeNull();
  });

  it('quoteUnavailable → 取得不能の案内行', () => {
    render(<PostCard post={makePost({ quoteUnavailable: true })} />);
    expect(screen.getByText('元の投稿は表示できません')).toBeInTheDocument();
    expect(document.querySelector('.quote-card')).toBeNull();
  });

  it('引用先への操作ボタン（返信・引用）は描画しない', () => {
    render(<PostCard post={makePost({ quote: makeQuote() })} onReply={() => {}} onQuote={() => {}} />);
    fireEvent.click(screen.getByText('もっと見る'));
    const meta = document.querySelector('.quote-meta') as HTMLElement;
    expect(within(meta).queryByText('返信')).toBeNull();
    expect(within(meta).queryByText('引用')).toBeNull();
  });
});

describe('CW 折りたたみ（docs/cw-display-spec.md）', () => {
  it('cw があると既定で折りたたまれ、本文・Media・quote が隠れる', () => {
    const post = makePost({
      cw: 'ネタバレ',
      quote: {
        id: 'q1',
        provider: 'bluesky',
        author: { id: 'u-q', handle: 'q', displayName: 'Q' },
        text: 'inner',
        createdAt: NOW.toISOString(),
        media: [],
        stats: { replies: 0, reposts: 0, likes: 0 },
        source: {},
      },
    });
    render(<PostCard post={post} />);
    expect(screen.getByText('ネタバレ')).toBeInTheDocument();
    expect(screen.queryByText('こんにちは世界')).toBeNull();
    expect(screen.queryByText('inner')).toBeNull();
    expect(screen.getByText('表示する')).toBeInTheDocument();
  });

  it('「表示する」で本文が表示され、「隠す」で戻る', () => {
    render(<PostCard post={makePost({ cw: 'CW テキスト' })} />);
    fireEvent.click(screen.getByText('表示する'));
    expect(screen.getByText('こんにちは世界')).toBeInTheDocument();
    fireEvent.click(screen.getByText('隠す'));
    expect(screen.queryByText('こんにちは世界')).toBeNull();
  });

  it('cw 空文字 → ピルは「CW」表示で折りたたみ（防御的フォールバック）', () => {
    render(<PostCard post={makePost({ cw: '' })} />);
    expect(screen.getByText('CW')).toBeInTheDocument();
    expect(screen.queryByText('こんにちは世界')).toBeNull();
    fireEvent.click(screen.getByText('表示する'));
    expect(screen.getByText('こんにちは世界')).toBeInTheDocument();
  });

  it('引用カード内の CW は親と独立して折りたたまれる', () => {
    const quote: Post = {
      id: 'q1',
      provider: 'misskey',
      author: { id: 'u-q', handle: 'q', displayName: 'Q' },
      text: '秘密の引用本文',
      createdAt: NOW.toISOString(),
      cw: '閲覧注意',
      media: [],
      stats: { replies: 0, reposts: 0, likes: 0 },
      source: {},
    };
    render(<PostCard post={makePost({ quote })} />);
    // 親の本文は見えるが、引用内の本文は伏せられたまま
    expect(screen.getByText('こんにちは世界')).toBeInTheDocument();
    expect(screen.queryByText('秘密の引用本文')).toBeNull();
    expect(screen.getByText('閲覧注意')).toBeInTheDocument();
    // 引用カード内のトグルで開く（親の本文と区別するため within でカード内を検索）
    const card = document.querySelector('.quote-card') as HTMLElement;
    fireEvent.click(within(card).getByText('表示する'));
    expect(within(card).getByText('秘密の引用本文')).toBeInTheDocument();
    // CW 展開後は截断なし（quote-body-clamp が付かない）
    expect(card.querySelector('.quote-body-clamp')).toBeNull();
  });
});

describe('スレッド入口（docs/thread-view-spec.md §6.1 / §7）', () => {
  it('カード本文クリックで onOpenThread が呼ばれる', () => {
    const onOpenThread = vi.fn();
    render(<PostCard post={makePost()} onOpenThread={onOpenThread} />);
    fireEvent.click(screen.getByText('こんにちは世界'));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread.mock.calls[0][0].id).toBe('p1');
  });

  it('onOpenThread が無ければクリックしても何も起きない（card-clickable も付かない）', () => {
    const { container } = render(<PostCard post={makePost()} />);
    expect(container.querySelector('.card-clickable')).toBeNull();
  });

  it('アクションボタン（返信）クリックは貫通しない', () => {
    const onOpenThread = vi.fn();
    const onReply = vi.fn();
    render(<PostCard post={makePost()} onOpenThread={onOpenThread} onReply={onReply} />);
    fireEvent.click(screen.getByRole('button', { name: '返信' }));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('本文内リンククリックは貫通しない', () => {
    const onOpenThread = vi.fn();
    const post = makePost({ rich: [{ type: 'link', url: 'https://example.com', text: 'example' }] });
    render(<PostCard post={post} onOpenThread={onOpenThread} />);
    fireEvent.click(screen.getByText('example'));
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('quote card 本体クリックで引用先のスレッドを開く', () => {
    const onOpenThread = vi.fn();
    const quoted = makePost({ id: 'q1', text: '引用本文' });
    render(<PostCard post={makePost({ quote: quoted })} onOpenThread={onOpenThread} />);
    fireEvent.click(screen.getByText('引用本文'));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread.mock.calls[0][0].id).toBe('q1');
  });

  it('quote card の「もっと見る」トグルは遷移に貫通しない', () => {
    const onOpenThread = vi.fn();
    const quoted = makePost({ id: 'q1', text: '引用本文' });
    render(<PostCard post={makePost({ quote: quoted })} onOpenThread={onOpenThread} />);
    fireEvent.click(screen.getByRole('button', { name: 'もっと見る' }));
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('quoteUnavailable 行クリックでは引用先スレッドを開かない（外側投稿のスレッドは開く）', () => {
    const onOpenThread = vi.fn();
    render(<PostCard post={makePost({ quoteUnavailable: true })} onOpenThread={onOpenThread} />);
    fireEvent.click(screen.getByText('元の投稿は表示できません'));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread.mock.calls[0][0].id).toBe('p1');
  });
});

describe('ユーザーメニュー（docs/block-mute-spec.md §5.1）', () => {
  beforeEach(() => {
    mod.muteUser.mockClear();
    mod.blockUser.mockClear();
    mod.isOwnPost.mockResolvedValue(false);
  });

  it('⋯ から「ミュート」「ブロック」を出し、ミュートは即実行する', async () => {
    const post = makePost();
    render(<PostCard post={post} />);
    fireEvent.click(screen.getByRole('button', { name: 'ユーザーメニュー' }));
    // own 判定（isOwnPost）の解決を待ってから項目が出る（自分の投稿への誤操作窓をなくす）
    await act(async () => {});
    const mute = screen.getByRole('menuitem', { name: 'このユーザーをミュート' });
    expect(mute).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'このユーザーをブロック' })).toBeInTheDocument();
    fireEvent.click(mute);
    expect(mod.muteUser).toHaveBeenCalledTimes(1);
    expect(mod.muteUser.mock.calls[0][0]).toMatchObject({ id: 'p1' });
  });

  it('ブロックは確認ダイアログを経て実行する', async () => {
    const post = makePost();
    render(<PostCard post={post} />);
    fireEvent.click(screen.getByRole('button', { name: 'ユーザーメニュー' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('menuitem', { name: 'このユーザーをブロック' }));
    // 確認ダイアログ（ハンドルと影響の説明）
    expect(screen.getByText('@alice.bsky.social をブロックしますか？')).toBeInTheDocument();
    expect(screen.getByText(/リプライ等ができなくなります/)).toBeInTheDocument();
    // キャンセルでは実行されない
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(mod.blockUser).not.toHaveBeenCalled();
    // もう一度開いて確定で実行
    fireEvent.click(screen.getByRole('button', { name: 'ユーザーメニュー' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('menuitem', { name: 'このユーザーをブロック' }));
    fireEvent.click(screen.getByRole('button', { name: 'ブロック' }));
    expect(mod.blockUser).toHaveBeenCalledTimes(1);
  });

  it('自分の投稿では項目を出さない（メニューボタン自体は残す）', async () => {
    mod.isOwnPost.mockResolvedValue(true);
    render(<PostCard post={makePost()} />);
    fireEvent.click(screen.getByRole('button', { name: 'ユーザーメニュー' }));
    // own 判定の解決前も解決後も項目は出ない
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    await act(async () => {});
    expect(mod.isOwnPost).toHaveBeenCalled();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('nostr（読み取り専用）ではメニューボタン自体を出さない', () => {
    render(<PostCard post={makePost({ provider: 'nostr' })} />);
    expect(screen.queryByRole('button', { name: 'ユーザーメニュー' })).not.toBeInTheDocument();
  });

  it('カードクリック（スレッド遷移）はメニューに貫通しない', async () => {
    const onOpenThread = vi.fn();
    render(<PostCard post={makePost()} onOpenThread={onOpenThread} />);
    fireEvent.click(screen.getByRole('button', { name: 'ユーザーメニュー' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('menuitem', { name: 'このユーザーをミュート' }));
    expect(onOpenThread).not.toHaveBeenCalled();
  });
});

describe('プロフィール入口（docs/profile-view-spec.md §8.1）', () => {
  it('onOpenProfile 有り: アバター・表示名・@handle がボタンになり、クリックで発火する', () => {
    const onOpenProfile = vi.fn();
    render(<PostCard post={makePost()} onOpenProfile={onOpenProfile} />);
    fireEvent.click(screen.getByRole('button', { name: /プロフィールを開く/ }));
    expect(onOpenProfile).toHaveBeenCalledWith('bluesky', expect.objectContaining({ id: 'did:plc:alice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    expect(onOpenProfile).toHaveBeenCalledWith('bluesky', expect.objectContaining({ id: 'did:plc:alice' }));
    fireEvent.click(screen.getByRole('button', { name: '@alice.bsky.social' }));
    expect(onOpenProfile).toHaveBeenCalledWith('bluesky', expect.objectContaining({ id: 'did:plc:alice' }));
    expect(onOpenProfile).toHaveBeenCalledTimes(3);
  });

  it('onOpenProfile が無ければ入口はボタン化しない（名前は span）', () => {
    render(<PostCard post={makePost()} />);
    expect(screen.queryByRole('button', { name: 'Alice' })).toBeNull();
    expect(screen.queryByRole('button', { name: /プロフィールを開く/ })).toBeNull();
  });

  it('プロフィールボタンのクリックでスレッドは開かない（貫通制御）', () => {
    const onOpenThread = vi.fn();
    const onOpenProfile = vi.fn();
    render(<PostCard post={makePost()} onOpenThread={onOpenThread} onOpenProfile={onOpenProfile} />);
    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    expect(onOpenProfile).toHaveBeenCalledTimes(1);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('リポスト行の名前クリックでリポストした人のプロフィールを開く', () => {
    const onOpenProfile = vi.fn();
    const post = makePost({
      repostedBy: { id: 'did:plc:bob', handle: 'bob.bsky.social', displayName: 'Bob' },
    });
    render(<PostCard post={post} onOpenProfile={onOpenProfile} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }));
    expect(onOpenProfile).toHaveBeenCalledWith('bluesky', expect.objectContaining({ id: 'did:plc:bob' }));
  });

  it('quote card の著者行クリックで引用元の投稿者のプロフィールを開く（スレッド遷移はしない）', () => {
    const onOpenThread = vi.fn();
    const onOpenProfile = vi.fn();
    const quoted = makePost({
      id: 'q1',
      author: { id: 'did:plc:carol', handle: 'carol.bsky.social', displayName: 'Carol' },
      text: '引用される投稿',
    });
    render(<PostCard post={makePost({ quote: quoted })} onOpenThread={onOpenThread} onOpenProfile={onOpenProfile} />);
    fireEvent.click(screen.getByRole('button', { name: 'Carol' }));
    expect(onOpenProfile).toHaveBeenCalledWith('bluesky', expect.objectContaining({ id: 'did:plc:carol' }));
    expect(onOpenThread).not.toHaveBeenCalled();
  });
});
