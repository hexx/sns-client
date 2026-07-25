import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PostCard } from './PostCard';
import type { Post } from '../../../shared/types';

const NOW = new Date('2026-07-01T12:00:00Z');

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    provider: 'bluesky',
    author: {
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
    const post = makePost({ author: { handle: 'b.bsky.social', displayName: 'Bob' } });
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
