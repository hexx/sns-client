/**
 * ProfileView: 投稿者のプロフィール（概要＋投稿一覧）をオーバーレイで表示する（docs/profile-view-spec.md）。
 * Lightbox / ThreadView / Compose と同一のオーバーレイパターン（ルーター非導入。§2）。
 * - データ: bsky/misskey は BFF、nostr はブラウザ直接解決。いずれも同じ Profile / TimelineResponse に合流する（lib/profile.ts）。
 * - 概要: バナー・アバター・表示名・@handle・自己紹介・カウント・follow ボタン・↗ 外部リンク（§8.2）。
 * - 一覧: 投稿＋リポストを PostCard 再利用で描画。無限スクロール（cursor）。自動更新・新着ピルは無し（§8.2）。
 * - 置換: 一覧内の別ユーザー入口で同一オーバーレイ内に引き直す（スタックしない。§2）。本人への入口は反応しない。
 * - follow: 楽観更新（like/repost と同じ流儀）。nostr は読み取り専用・自分のプロフィールでは非表示（§6/Q6/Q9）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../api';
import { fetchProfile, fetchProfilePosts } from '../lib/profile';
import { isHiddenPost, loadMe, subscribeHidden } from '../lib/moderation';
import { applyReaction } from '../lib/reactions';
import { withLike, withRenoteIncrement, withRepost } from '../lib/engagements';
import type { Author, Post, Profile, Provider } from '../../../shared/types';
import { PostCard } from './PostCard';
import { RichText } from './RichText';

const PROVIDER_LABEL: Record<string, string> = { bluesky: 'Bluesky', misskey: 'Misskey', nostr: 'Nostr' };

type Status = 'loading' | 'done' | 'error' | 'unavailable';

/** プロバイダをまたぐ id 衝突を避けるグローバル識別子（TimelineCore と同じ） */
function pid(p: Post): string {
  return `${p.provider}:${p.id}`;
}
function authorKey(provider: Provider, a: Author): string {
  return `${provider}:${a.id}`;
}

export function ProfileView({
  provider,
  author,
  onOpenThread,
  onReply,
  onQuote,
  onClose,
}: {
  /** 初期ターゲットの Provider（Author.id の解釈に使う） */
  provider: Provider;
  author: Author;
  onOpenThread?: (p: Post) => void;
  onReply?: (p: Post) => void;
  onQuote?: (p: Post) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<{ provider: Provider; author: Author }>({ provider, author });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [nonce, setNonce] = useState(0); // 再試行のトリガ
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listDone, setListDone] = useState(false); // 一覧の初回読み込み完了（「投稿はありません」表示のため）
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [isOwn, setIsOwn] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const reactionInflight = useRef<Set<string>>(new Set());
  const engageInflight = useRef<Set<string>>(new Set());
  /** ターゲットの最新値（loadMore / retryList の stale 応答破棄に使う。§8.2） */
  const targetRef = useRef(target);
  targetRef.current = target;
  /** ブロック/ミュートの非表示セット変化の再描画トリガ（docs/block-mute-spec.md §5.4） */
  const [, setModTick] = useState(0);
  const readOnly = target.provider === 'nostr';

  // 非表示ユーザーの投稿を一覧から外すため、セットの変化を購読して再描画する（§5.4）
  useEffect(() => subscribeHidden(() => setModTick((t) => t + 1)), []);

  // --- 概要＋一覧の読み込み（ターゲット置換・再試行で再実行。概要と一覧は別々に失敗を扱う） ---
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setProfile(null);
    setPosts([]);
    setCursor(null);
    setListDone(false);
    setListError(null);
    fetchProfile(target.provider, target.author)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setStatus('done');
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setStatus('unavailable'); // 削除・ブロック等（§9）
        } else {
          setErrorMsg(e instanceof Error ? e.message : String(e));
          setStatus('error');
        }
      });
    fetchProfilePosts(target.provider, target.author)
      .then((t) => {
        if (cancelled) return;
        setPosts(t.posts);
        setCursor(t.nextCursor);
        setListDone(true);
      })
      .catch((e) => {
        // 一覧のみ失敗は概要を表示したままエラー行＋再試行（§8.2）
        if (!cancelled) {
          setListError(e instanceof Error ? e.message : String(e));
          setListDone(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [target, nonce]);

  // ターゲット置換・再試行時に先頭へ戻す
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [target, nonce]);

  // Esc で閉じる（Lightbox と同一流儀。§2）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 背景スクロールロック（Lightbox と同一流儀）
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // --- 自分のプロフィールか（follow ボタンの非表示判定。PostMenu と同じ /api/me の lazy 判定） ---
  useEffect(() => {
    let cancelled = false;
    setIsOwn(false);
    const prov = target.provider;
    if (prov !== 'bluesky' && prov !== 'misskey') return;
    void loadMe().then((me) => {
      if (!cancelled) setIsOwn(me?.me[prov]?.actorId === target.author.id);
    });
    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- 一覧内ローカル状態への楽観更新（TimelineCore / ThreadView と同じ流儀。§8.2） ---
  const patchPost = useCallback((id: string, fn: (p: Post) => Post) => {
    setPosts((prev) => prev.map((p) => (pid(p) === id ? fn(p) : p)));
  }, []);

  const toggleReaction = useCallback(
    async (p: Post, reaction?: string, emojiUrl?: string) => {
      const id = pid(p);
      if (typeof p.ref !== 'string' || reactionInflight.current.has(id)) return;
      const original = p;
      reactionInflight.current.add(id);
      patchPost(id, (x) => applyReaction(x, reaction, emojiUrl));
      try {
        await api.react(p.ref, reaction);
      } catch {
        patchPost(id, () => original);
        setToast('リアクションに失敗しました');
      } finally {
        reactionInflight.current.delete(id);
      }
    },
    [patchPost],
  );

  const toggleLike = useCallback(
    async (p: Post) => {
      if (p.provider !== 'bluesky') return;
      const postRef = p.ref as { uri?: string; cid?: string } | undefined;
      const id = pid(p);
      if (!postRef?.uri || !postRef?.cid || engageInflight.current.has(id)) return;
      engageInflight.current.add(id);
      const original = p;
      const liked = Boolean(p.viewer?.likeUri);
      patchPost(id, (x) => withLike(x, !liked, liked ? undefined : `pending:${id}`));
      try {
        if (liked) {
          await api.unlike(p.viewer?.likeUri as string);
        } else {
          const res = await api.like(postRef.uri, postRef.cid);
          if (res.recordUri) patchPost(id, (x) => ({ ...x, viewer: { ...x.viewer, likeUri: res.recordUri } }));
        }
      } catch {
        patchPost(id, () => original);
        setToast('いいねに失敗しました');
      } finally {
        engageInflight.current.delete(id);
      }
    },
    [patchPost],
  );

  const toggleRepost = useCallback(
    async (p: Post) => {
      const id = pid(p);
      if (engageInflight.current.has(id)) return;
      engageInflight.current.add(id);
      if (p.provider === 'bluesky') {
        const postRef = p.ref as { uri?: string; cid?: string } | undefined;
        if (!postRef?.uri || !postRef?.cid) {
          engageInflight.current.delete(id);
          return;
        }
        const original = p;
        const reposted = Boolean(p.viewer?.repostUri);
        patchPost(id, (x) => withRepost(x, !reposted, reposted ? undefined : `pending:${id}`));
        try {
          if (reposted) {
            await api.unrepost(p.viewer?.repostUri as string);
          } else {
            const res = await api.repost('bluesky', postRef);
            if (res.recordUri) patchPost(id, (x) => ({ ...x, viewer: { ...x.viewer, repostUri: res.recordUri } }));
          }
        } catch {
          patchPost(id, () => original);
          setToast('リポストに失敗しました');
        } finally {
          engageInflight.current.delete(id);
        }
        return;
      }
      if (p.provider === 'misskey' && typeof p.ref === 'string') {
        try {
          await api.repost('misskey', p.ref);
          patchPost(id, withRenoteIncrement);
          setToast('リノートしました');
        } catch {
          setToast('リノートに失敗しました');
        } finally {
          engageInflight.current.delete(id);
        }
      } else {
        engageInflight.current.delete(id);
      }
    },
    [patchPost],
  );

  // --- follow / unfollow トグル（楽観更新。§6。nostr は非表示・自分のプロフィールでは非表示） ---
  const toggleFollow = useCallback(async () => {
    const p = profile;
    const t = target;
    if (!p || followBusy) return;
    if (p.provider !== 'bluesky' && p.provider !== 'misskey') return;
    // リクエスト中にターゲットが置換されたら、応答・ロールバックを現在のターゲットに適用しない（stale 防止）
    const apply = (fn: (x: Profile | null) => Profile | null) => {
      if (targetRef.current !== t) return;
      setProfile(fn);
    };
    setFollowBusy(true);
    const original = p;
    const following = Boolean(p.viewer?.following);
    apply((x) => (x ? { ...x, viewer: { following: !following, followUri: x.viewer?.followUri } } : x));
    try {
      if (following) {
        await api.unfollow(p.provider, p.author.id, p.viewer?.followUri);
        apply((x) => (x ? { ...x, viewer: { following: false } } : x));
      } else {
        const res = await api.follow(p.provider, p.author.id);
        apply((x) => (x ? { ...x, viewer: { following: true, ...(res.recordUri ? { followUri: res.recordUri } : {}) } } : x));
      }
    } catch {
      apply(() => original); // ロールバック
      setToast('フォローに失敗しました');
    } finally {
      setFollowBusy(false);
    }
  }, [profile, followBusy, target]);

  /** 一覧の再試行（概要は表示したまま。§8.2。ターゲット置換後の stale 応答は破棄） */
  const retryList = useCallback(async () => {
    const t = target;
    setListError(null);
    try {
      const data = await fetchProfilePosts(t.provider, t.author);
      if (targetRef.current !== t) return;
      setPosts(data.posts);
      setCursor(data.nextCursor);
      setListDone(true);
    } catch (e) {
      if (targetRef.current !== t) return;
      setListError(e instanceof Error ? e.message : String(e));
      setListDone(true);
    }
  }, [target]);

  // --- 追加読み込み（cursor ページング。無限スクロール。§8.2。ターゲット置換後の stale 応答は破棄） ---
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const t = target;
    setLoadingMore(true);
    try {
      const data = await fetchProfilePosts(t.provider, t.author, cursor);
      if (targetRef.current !== t) return;
      setPosts((prev) => [...prev, ...data.posts]);
      setCursor(data.nextCursor);
    } catch {
      if (targetRef.current === t) setToast('追加の読み込みに失敗しました');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, target]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  /**
   * 一覧内の別ユーザー入口（リポスト行・quote card の著者行）での置換。
   * 同一オーバーレイ内で引き直し、履歴は積まない（§2）。本人への入口は反応しない。
   */
  const openProfile = useCallback((p: Provider, a: Author) => {
    setTarget((t) => (authorKey(p, a) === authorKey(t.provider, t.author) ? t : { provider: p, author: a }));
  }, []);

  /** 一覧のカードへ配線するハンドラ群（nostr は閲覧専用なので操作系は undefined） */
  const handlers = readOnly
    ? {}
    : {
        onReply,
        onQuote,
        onReact: toggleReaction,
        onLike: (p: Post) => void toggleLike(p),
        onRepost: (p: Post) => void toggleRepost(p),
      };

  const following = Boolean(profile?.viewer?.following);
  const showFollow = !readOnly && !isOwn;
  /** 自己紹介（descriptionRich があればリッチ、なければプレーンテキスト。§8.2） */
  let bio: ReactNode = null;
  if (profile?.descriptionRich && profile.descriptionRich.length > 0) {
    bio = (
      <div className="profile-bio">
        <RichText segments={profile.descriptionRich} />
      </div>
    );
  } else if (profile?.description) {
    bio = <p className="profile-bio">{profile.description}</p>;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal profile-modal"
        role="dialog"
        aria-modal="true"
        aria-label="プロフィール"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="thread-title">
            プロフィール
            <span className="provider-badge thread-provider">{PROVIDER_LABEL[target.provider] ?? target.provider}</span>
          </span>
          <button type="button" className="link-btn" onClick={onClose}>
            閉じる
          </button>
        </div>

        <div className="profile-scroll" ref={scrollRef}>
          {status === 'loading' && <p className="empty">読み込み中…</p>}
          {status === 'error' && (
            <div className="banner error">
              プロフィールを読み込めませんでした{errorMsg ? `（${errorMsg}）` : ''}{' '}
              <button onClick={() => setNonce((n) => n + 1)}>再試行</button>
            </div>
          )}
          {status === 'unavailable' && <p className="empty">このユーザーは表示できません</p>}

          {profile && status === 'done' && (
            <>
              <div className="profile-header">
                {profile.bannerUrl && <img className="profile-banner" src={profile.bannerUrl} alt="" />}
                <div className="profile-id">
                  {profile.author.avatarUrl ? (
                    <img className="profile-avatar" src={profile.author.avatarUrl} alt="" />
                  ) : (
                    <div className="profile-avatar avatar-fallback" />
                  )}
                  <div className="profile-id-text">
                    <div className="profile-name">
                      {profile.author.displayNameRich && profile.author.displayNameRich.length > 0 ? (
                        <RichText segments={profile.author.displayNameRich} inline />
                      ) : (
                        profile.author.displayName
                      )}
                    </div>
                    <div className="profile-handle">@{profile.author.handle}</div>
                  </div>
                </div>
                <div className="profile-actions">
                  {showFollow && (
                    <button
                      type="button"
                      className={`profile-follow${following ? ' following' : ''}`}
                      onClick={() => void toggleFollow()}
                      disabled={followBusy}
                    >
                      {following ? 'フォロー中' : 'フォロー'}
                    </button>
                  )}
                  {profile.url && (
                    <a className="profile-ext" href={profile.url} target="_blank" rel="noopener noreferrer">
                      ↗ プロフィールを開く
                    </a>
                  )}
                </div>
                {bio}
                {profile.stats && (
                  <div className="profile-stats">
                    <span>
                      投稿 <strong>{profile.stats.posts}</strong>
                    </span>
                    <span>
                      フォロー <strong>{profile.stats.following}</strong>
                    </span>
                    <span>
                      フォロワー <strong>{profile.stats.followers}</strong>
                    </span>
                  </div>
                )}
              </div>

              {listError && (
                <div className="banner error">
                  投稿一覧を読み込めませんでした（{listError}）{' '}
                  <button type="button" onClick={() => void retryList()}>再試行</button>
                </div>
              )}

              <div className="profile-posts">
                {posts.map((p) =>
                  isHiddenPost(p) ? null : (
                    <PostCard
                      key={pid(p)}
                      post={p}
                      onOpenThread={onOpenThread}
                      onOpenProfile={openProfile}
                      {...handlers}
                    />
                  ),
                )}
                {listDone && posts.length === 0 && !listError && <p className="empty">投稿はありません</p>}
              </div>
            </>
          )}

          <div ref={sentinelRef} className="sentinel">
            {loadingMore && 'さらに読み込み中…'}
          </div>
          {toast && <div className="toast">{toast}</div>}
        </div>
      </div>
    </div>
  );
}
