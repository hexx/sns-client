// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileView } from './ProfileView';
import { api, ApiError } from '../api';
import { fetchProfile, fetchProfilePosts } from '../lib/profile';
import type { Author, Post, Profile } from '../../../shared/types';

// プロフィール取得は lib/profile でモック（BFF / nostr の分岐は lib 側の責務）
vi.mock('../lib/profile', () => ({
  fetchProfile: vi.fn(),
  fetchProfilePosts: vi.fn(),
}));
// ブロック・ミュート（docs/block-mute-spec.md §5）：アクション関数と自分の投稿判定を制御可能にする
const mod = vi.hoisted(() => ({
  loadMe: vi.fn().mockResolvedValue(null),
}));
vi.mock('../lib/moderation', () => ({
  loadMe: mod.loadMe,
  isHiddenPost: () => false,
  subscribeHidden: () => () => {},
  subscribeModerationToasts: () => () => {},
  muteUser: vi.fn(),
  blockUser: vi.fn(),
  isOwnPost: vi.fn().mockResolvedValue(false),
  resetModerationForTests: () => {},
}));
// api は follow/unfollow のみ使用（他は実物維持）
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, follow: vi.fn(), unfollow: vi.fn() } };
});

// --- IntersectionObserver を捕捉し、テスト側から発火できるようにする ---
type IOInstance = { callback: IntersectionObserverCallback };
let ioInstances: IOInstance[] = [];

class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    ioInstances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function triggerIntersection(): void {
  const last = ioInstances[ioInstances.length - 1];
  last.callback([{ isIntersecting: true } as IntersectionObserverEntry], last as unknown as IntersectionObserver);
}

const mockProfile = vi.mocked(fetchProfile);
const mockPosts = vi.mocked(fetchProfilePosts);
const mockFollow = vi.mocked(api.follow);
const mockUnfollow = vi.mocked(api.unfollow);

const ALICE: Author = {
  id: 'did:plc:alice',
  handle: 'alice.bsky.social',
  displayName: 'Alice',
  avatarUrl: 'https://example.com/a.png',
};

function profile(over: Partial<Profile> = {}): Profile {
  return {
    provider: 'bluesky',
    author: ALICE,
    description: 'こんにちは',
    bannerUrl: 'https://example.com/b.png',
    stats: { posts: 10, following: 20, followers: 30 },
    viewer: { following: false },
    url: 'https://bsky.app/profile/did:plc:alice',
    ...over,
  };
}

function post(over: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    provider: 'bluesky',
    author: ALICE,
    text: 'テスト投稿',
    createdAt: '2026-07-01T12:00:00Z',
    media: [],
    stats: { replies: 0, reposts: 0, likes: 0 },
    ref: { uri: 'at://x', cid: 'c' },
    source: {},
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ioInstances = [];
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  mockProfile.mockResolvedValue(profile());
  mockPosts.mockResolvedValue({ posts: [post()], nextCursor: null });
  mockFollow.mockResolvedValue({ recordUri: 'at://did:plc:me/app.bsky.graph.follow/abc' });
  mockUnfollow.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProfileView', () => {
  it('概要（バナー・アバター・名前・@handle・自己紹介・stats）と投稿一覧を描画する', async () => {
    render(<ProfileView provider="bluesky" author={ALICE} onClose={vi.fn()} />);
    // 名前はヘッダーと投稿カードに現れうるため findAll で確認
    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('@alice.bsky.social')).length).toBeGreaterThan(0);
    expect(screen.getByText('こんにちは')).toBeTruthy();
    expect(screen.getByText('投稿')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('テスト投稿')).toBeTruthy();
    expect(screen.getByRole('link', { name: /プロフィールを開く/ })).toHaveAttribute(
      'href',
      'https://bsky.app/profile/did:plc:alice',
    );
    expect(mockProfile).toHaveBeenCalledWith('bluesky', ALICE);
  });

  it('フォロー中でない → 「フォロー」ボタン。クリックで api.follow を呼び楽観更新で「フォロー中」になる', async () => {
    render(<ProfileView provider="bluesky" author={ALICE} onClose={vi.fn()} />);
    const btn = await screen.findByRole('button', { name: 'フォロー' });
    fireEvent.click(btn);
    expect(mockFollow).toHaveBeenCalledWith('bluesky', 'did:plc:alice');
    await waitFor(() => expect(screen.getByRole('button', { name: 'フォロー中' })).toBeTruthy());
  });

  it('フォロー中 → 「フォロー中」ボタン。クリックで api.unfollow（followUri 付き）を呼ぶ', async () => {
    mockProfile.mockResolvedValue(
      profile({ viewer: { following: true, followUri: 'at://did:plc:me/app.bsky.graph.follow/abc' } }),
    );
    render(<ProfileView provider="bluesky" author={ALICE} onClose={vi.fn()} />);
    const btn = await screen.findByRole('button', { name: 'フォロー中' });
    fireEvent.click(btn);
    expect(mockUnfollow).toHaveBeenCalledWith('bluesky', 'did:plc:alice', 'at://did:plc:me/app.bsky.graph.follow/abc');
    await waitFor(() => expect(screen.getByRole('button', { name: 'フォロー' })).toBeTruthy());
  });

  it('nostr は follow ボタンを表示しない（読み取り専用。§8.2）', async () => {
    mockProfile.mockResolvedValue({
      provider: 'nostr',
      author: { id: 'ab'.repeat(32), handle: 'npub1abc…wxyz', displayName: 'NostrUser' },
      description: 'about',
    });
    render(
      <ProfileView
        provider="nostr"
        author={{ id: 'ab'.repeat(32), handle: 'npub1abc…wxyz', displayName: 'NostrUser' }}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText('NostrUser')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /フォロー/ })).toBeNull();
    // nostr は stats を持たないためカウント行も無い
    expect(screen.queryByText('フォロワー')).toBeNull();
  });

  it('自分のプロフィールでは follow ボタンを非表示にする（/api/me 判定。§8.2）', async () => {
    mod.loadMe.mockResolvedValue({ me: { bluesky: { actorId: 'did:plc:alice' }, misskey: null } });
    render(<ProfileView provider="bluesky" author={ALICE} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: /フォロー/ })).toBeNull());
  });

  it('概要の取得失敗（404）は「このユーザーは表示できません」プレースホルダ（§9）', async () => {
    mockProfile.mockRejectedValue(new ApiError(404, 'profile unavailable'));
    render(<ProfileView provider="bluesky" author={ALICE} onClose={vi.fn()} />);
    expect(await screen.findByText('このユーザーは表示できません')).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
  });

  it('一覧のみ失敗は概要を表示したままエラー行＋再試行で回復する（§8.2）', async () => {
    mockPosts.mockRejectedValueOnce(new Error('boom'));
    render(<ProfileView provider="bluesky" author={ALICE} onClose={vi.fn()} />);
    expect(await screen.findByText(/投稿一覧を読み込めませんでした/)).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy(); // 概要は表示されたまま
    mockPosts.mockResolvedValue({ posts: [post()], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByText('テスト投稿')).toBeTruthy();
    expect(screen.queryByText(/投稿一覧を読み込めませんでした/)).toBeNull();
  });

  it('一覧内の別ユーザー入口（リポスト行）で同一オーバーレイ内に置換する（§2）', async () => {
    const bob = { id: 'did:plc:bob', handle: 'bob.bsky.social', displayName: 'Bob' };
    mockPosts.mockResolvedValue({
      posts: [post({ repostedBy: bob })],
      nextCursor: null,
    });
    render(<ProfileView provider="bluesky" author={ALICE} onClose={vi.fn()} />);
    await screen.findByText('テスト投稿');
    mockProfile.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }));
    await waitFor(() =>
      expect(mockProfile).toHaveBeenCalledWith('bluesky', expect.objectContaining({ id: 'did:plc:bob' })),
    );
  });

  it('プロフィール本人への入口は反応しない（再取得しない。§2）', async () => {
    mockPosts.mockResolvedValue({ posts: [post()], nextCursor: null });
    render(<ProfileView provider="bluesky" author={ALICE} onClose={vi.fn()} />);
    await screen.findByText('テスト投稿');
    mockProfile.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    // マイクロタスク後に呼ばれていないことを確認
    await Promise.resolve();
    expect(mockProfile).not.toHaveBeenCalled();
  });

  it('投稿一覧が空なら「投稿はありません」を表示する', async () => {
    mockPosts.mockResolvedValue({ posts: [], nextCursor: null });
    render(<ProfileView provider="bluesky" author={ALICE} onClose={vi.fn()} />);
    expect(await screen.findByText('投稿はありません')).toBeTruthy();
  });

  it('無限スクロール: cursor があれば sentinel 交差で追加読み込みする（§8.2）', async () => {
    mockPosts
      .mockResolvedValueOnce({ posts: [post()], nextCursor: 'c1' })
      .mockResolvedValueOnce({ posts: [post({ id: 'p2', text: '2件目' })], nextCursor: null });
    render(<ProfileView provider="bluesky" author={ALICE} onClose={vi.fn()} />);
    await screen.findByText('テスト投稿');
    act(() => triggerIntersection());
    expect(await screen.findByText('2件目')).toBeTruthy();
    expect(mockPosts).toHaveBeenCalledWith('bluesky', ALICE, 'c1');
  });

  it('Esc で閉じる', async () => {
    const onClose = vi.fn();
    render(<ProfileView provider="bluesky" author={ALICE} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ProfileView: misskey follow（docs/profile-view-spec.md §6）', () => {
  it('misskey のフォローは api.follow(misskey) を呼び、recordUri 無しでも成功として反映する', async () => {
    mockProfile.mockResolvedValue({
      provider: 'misskey',
      author: { id: 'u-alice', handle: 'alice', displayName: 'Alice' },
      viewer: { following: false },
    });
    mockFollow.mockResolvedValue({}); // misskey は recordUri 無し
    render(<ProfileView provider="misskey" author={{ id: 'u-alice', handle: 'alice', displayName: 'Alice' }} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'フォロー' }));
    expect(mockFollow).toHaveBeenCalledWith('misskey', 'u-alice');
    await waitFor(() => expect(screen.getByRole('button', { name: 'フォロー中' })).toBeTruthy());
  });

  it('misskey のフォロー解除は api.unfollow(misskey) を actorId で呼ぶ', async () => {
    mockProfile.mockResolvedValue({
      provider: 'misskey',
      author: { id: 'u-alice', handle: 'alice', displayName: 'Alice' },
      viewer: { following: true },
    });
    render(<ProfileView provider="misskey" author={{ id: 'u-alice', handle: 'alice', displayName: 'Alice' }} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'フォロー中' }));
    expect(mockUnfollow).toHaveBeenCalledWith('misskey', 'u-alice');
    await waitFor(() => expect(screen.getByRole('button', { name: 'フォロー' })).toBeTruthy());
  });
});
