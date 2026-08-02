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
  /** follow の in-flight ガード（再描画前の連続クリックで同じ操作を二重送信しない。engageInflight と同じ流儀） */
  const followBusyRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const reactionInflight = useRef<Set<string>>(new Set());
  const engageInflight = useRef<Set<string>>(new Set());
  /** 追加読み込みの in-flight ガード（再描画前の連続発火で同じ cursor を二重取得しない。TimelineCore と同じ流儀） */
  const loadingMoreRef = useRef(false);
  /** 読み込みの世代トークン（openProfile / 再試行で increment。旧ターゲット・旧ページの応答・finally を無効化する） */
  const loadGenRef = useRef(0);
  /** cursor の latest ref（loadMore を安定化し、IntersectionObserver の再購読・連鎖読み込みを防ぐ） */
  const cursorRef = useRef<string | null>(null);
  cursorRef.current = cursor;
  /** 表示済み投稿 id の Set（追記時の重複排除を O(1) にする。ターゲット切替でリセット） */
  const seenPostIds = useRef<Set<string>>(new Set());
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
    loadGenRef.current += 1; // 再取得・再試行ごとに世代を進める（in-flight の loadMore 応答を無効化）
    const gen = loadGenRef.current;
    loadingMoreRef.current = false;
    setStatus('loading');
    setProfile(null);
    setPosts([]);
    setCursor(null);
    setListDone(false);
    setListError(null);
    setLoadingMore(false);
    fetchProfile(target.provider, target.author)
      .then((p) => {
        if (cancelled || gen !== loadGenRef.current) return;
        setProfile(p);
        setStatus('done');
      })
      .catch((e) => {
        if (cancelled || gen !== loadGenRef.current) return;
        if (e instanceof ApiError && e.status === 404) {
          setStatus('unavailable'); // 削除・ブロック等（§9）
        } else {
          setErrorMsg(e instanceof Error ? e.message : String(e));
          setStatus('error');
        }
      });
    fetchProfilePosts(target.provider, target.author)
      .then((t) => {
        if (cancelled || gen !== loadGenRef.current) return;
        seenPostIds.current = new Set(t.posts.map(pid));
        setPosts(t.posts);
        setCursor(t.nextCursor);
        setListDone(true);
      })
      .catch((e) => {
        // 一覧のみ失敗は概要を表示したままエラー行＋再試行（§8.2）
        if (!cancelled && gen === loadGenRef.current) {
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
  /** ターゲット置換後の stale 応答で一覧を書き換えないためのガード付きパッチ（§8.2） */
  const patchPostFor = useCallback(
    (t: { provider: Provider; author: Author }, id: string, fn: (p: Post) => Post) => {
      if (targetRef.current !== t) return;
      setPosts((prev) => prev.map((p) => (pid(p) === id ? fn(p) : p)));
    },
    [],
  );

  const toggleReaction = useCallback(
    async (p: Post, reaction?: string, emojiUrl?: string) => {
      const id = pid(p);
      const t = target;
      if (typeof p.ref !== 'string' || reactionInflight.current.has(id)) return;
      const original = p;
      reactionInflight.current.add(id);
      patchPostFor(t, id, (x) => applyReaction(x, reaction, emojiUrl));
      try {
        await api.react(p.ref, reaction);
      } catch {
        patchPostFor(t, id, () => original);
        if (targetRef.current === t) setToast('リアクションに失敗しました');
      } finally {
        reactionInflight.current.delete(id);
      }
    },
    [patchPostFor, target],
  );

  const toggleLike = useCallback(
    async (p: Post) => {
      if (p.provider !== 'bluesky') return;
      const postRef = p.ref as { uri?: string; cid?: string } | undefined;
      const id = pid(p);
      const t = target;
      if (!postRef?.uri || !postRef?.cid || engageInflight.current.has(id)) return;
      engageInflight.current.add(id);
      const original = p;
      const liked = Boolean(p.viewer?.likeUri);
      patchPostFor(t, id, (x) => withLike(x, !liked, liked ? undefined : `pending:${id}`));
      try {
        if (liked) {
          await api.unlike(p.viewer?.likeUri as string);
        } else {
          const res = await api.like(postRef.uri, postRef.cid);
          if (res.recordUri) {
            patchPostFor(t, id, (x) => ({ ...x, viewer: { ...x.viewer, likeUri: res.recordUri } }));
          } else {
            // recordUri が返らないとトグル状態を追跡できないため戻す（pending センチネルを残さない）
            patchPostFor(t, id, () => original);
            if (targetRef.current === t) setToast('いいねに失敗しました');
          }
        }
      } catch {
        patchPostFor(t, id, () => original);
        if (targetRef.current === t) setToast('いいねに失敗しました');
      } finally {
        engageInflight.current.delete(id);
      }
    },
    [patchPostFor, target],
  );

  const toggleRepost = useCallback(
    async (p: Post) => {
      const id = pid(p);
      const t = target;
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
        patchPostFor(t, id, (x) => withRepost(x, !reposted, reposted ? undefined : `pending:${id}`));
        try {
          if (reposted) {
            await api.unrepost(p.viewer?.repostUri as string);
          } else {
            const res = await api.repost('bluesky', postRef);
            if (res.recordUri) {
              patchPostFor(t, id, (x) => ({ ...x, viewer: { ...x.viewer, repostUri: res.recordUri } }));
            } else {
              patchPostFor(t, id, () => original);
              if (targetRef.current === t) setToast('リポストに失敗しました');
            }
          }
        } catch {
          patchPostFor(t, id, () => original);
          if (targetRef.current === t) setToast('リポストに失敗しました');
        } finally {
          engageInflight.current.delete(id);
        }
        return;
      }
      if (p.provider === 'misskey' && typeof p.ref === 'string') {
        try {
          await api.repost('misskey', p.ref);
          patchPostFor(t, id, withRenoteIncrement);
          if (targetRef.current === t) setToast('リノートしました');
        } catch {
          if (targetRef.current === t) setToast('リノートに失敗しました');
        } finally {
          engageInflight.current.delete(id);
        }
      } else {
        engageInflight.current.delete(id);
      }
    },
    [patchPostFor, target],
  );

  // --- follow / unfollow トグル（楽観更新。§6。nostr は非表示・自分のプロフィールでは非表示） ---
  const toggleFollow = useCallback(async () => {
    const p = profile;
    const t = target;
    if (!p || followBusy || followBusyRef.current) return;
    if (p.provider !== 'bluesky' && p.provider !== 'misskey') return;
    // リクエスト中にターゲットが置換されたら、応答・ロールバックを現在のターゲットに適用しない（stale 防止）
    const apply = (fn: (x: Profile | null) => Profile | null) => {
      if (targetRef.current !== t) return;
      setProfile(fn);
    };
    followBusyRef.current = true;
    setFollowBusy(true);
    const original = p;
    const following = Boolean(p.viewer?.following);
    apply((x) => (x ? { ...x, viewer: { following: !following, followUri: x.viewer?.followUri } } : x));
    try {
      if (following) {
        // bsky は解除に viewer.followUri が必要（api.unfollow の型で強制。無ければ失敗として戻す）
        if (p.provider === 'bluesky') {
          const followUri = p.viewer?.followUri;
          if (!followUri) {
            apply(() => original); // 楽観更新を戻す
            if (targetRef.current === t) setToast('フォロー解除に失敗しました');
            return;
          }
          await api.unfollow('bluesky', p.author.id, followUri);
        } else {
          await api.unfollow('misskey', p.author.id);
        }
        apply((x) => (x ? { ...x, viewer: { following: false } } : x));
      } else {
        // misskey は recordUri を持たない（解除は actorId 指定）ため、成功ならそのまま反映する
        if (p.provider === 'misskey') {
          apply((x) => (x ? { ...x, viewer: { following: true } } : x));
        } else {
          const res = await api.follow('bluesky', p.author.id);
          if (res.recordUri) {
            apply((x) => (x ? { ...x, viewer: { following: true, followUri: res.recordUri } } : x));
          } else {
            // recordUri が返らないと解除（followUri）に使えずトグル状態を追跡できないため戻す（like/repost と同じ）
            apply(() => original);
            if (targetRef.current === t) setToast('フォローに失敗しました');
          }
        }
      }
    } catch {
      // どの操作に失敗したかを正確に伝える（フォロー中 → 解除に失敗、未フォロー → フォローに失敗）
      apply(() => original); // ロールバック
      if (targetRef.current === t) setToast(following ? 'フォロー解除に失敗しました' : 'フォローに失敗しました');
    } finally {
      followBusyRef.current = false;
      setFollowBusy(false);
    }
  }, [profile, followBusy, target]);

  /** 一覧の再試行（概要は表示したまま。§8.2。ターゲット置換後の stale 応答は破棄） */
  const retryList = useCallback(async () => {
    const t = target;
    loadGenRef.current += 1; // in-flight の loadMore 応答を無効化（再試行後のリストに混入させない）
    loadingMoreRef.current = false;
    setListError(null);
    setListDone(false); // 再試行中は「投稿はありません」を出さない（空状態の誤表示防止）
    try {
      const data = await fetchProfilePosts(t.provider, t.author);
      if (targetRef.current !== t) return;
      seenPostIds.current = new Set(data.posts.map(pid)); // 再試行の先頭ページで dedup セットを作り直す
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
    // deps を空にして安定化する（再生成 → IO 再購読 → 可視中の sentinel で連鎖読み込みになるため）。
    // 最新の cursor / target は ref から読み、in-flight は ref で管理する
    const cur = cursorRef.current;
    const t = targetRef.current;
    if (!cur || loadingMoreRef.current) return;
    const gen = loadGenRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const data = await fetchProfilePosts(t.provider, t.author, cur);
      if (targetRef.current !== t || gen !== loadGenRef.current) return;
      // ページ境界の重複（nostr の自己リポスト等）を pid の Set で除いて追記する
      const fresh = data.posts.filter((q) => !seenPostIds.current.has(pid(q)));
      for (const q of fresh) seenPostIds.current.add(pid(q));
      // raw ウィンドウ区切りのページ境界で表示順が前後しないよう、追記後に時系列降順で整列し直す
      setPosts((prev) =>
        [...prev, ...fresh].toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
      );
      setCursor(data.nextCursor);
    } catch {
      if (targetRef.current === t && gen === loadGenRef.current) setToast('追加の読み込みに失敗しました');
    } finally {
      if (gen === loadGenRef.current) {
        loadingMoreRef.current = false; // 旧世代の finally は新世代のフラグを消さない
        setLoadingMore(false);
      }
    }
  }, []);

  /** 一覧表示の準備ができたか（sentinel のマウント条件。IO の再購読トリガに使う） */
  const profileReady = profile !== null && status === 'done';
  /** 一覧セクションの表示条件（概要の成功時、または概要エラーだが一覧は読めたとき。unavailable は除く） */
  const profileReadyOrListReady = profileReady || (status === 'error' && listDone);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, profileReadyOrListReady]);

  /**
   * 一覧内の別ユーザー入口（リポスト行・quote card の著者行）での置換。
   * 同一オーバーレイ内で引き直し、履歴は積まない（§2）。本人への入口は反応しない。
   * 一覧の状態（cursor・listDone・listError）は setTarget の外で同期リセットする
   * （updater は純粋であるべき。また useEffect は描画後なので、その間の IntersectionObserver
   * 発火が前ターゲットの cursor で誤ページングするのを防ぐ）。
   */
  const openProfile = useCallback((p: Provider, a: Author) => {
    if (authorKey(p, a) === authorKey(targetRef.current.provider, targetRef.current.author)) return;
    targetRef.current = { provider: p, author: a }; // 再描画前の stale ガードを先に反映
    loadGenRef.current += 1; // 旧ターゲットの in-flight 応答・finally を無効化
    // 一覧・概要の状態を同期的に全リセット（useEffect は描画後に走るため、
    // その間の描画で前ターゲットの中身が一瞬見えるのを防ぐ。§8.2）。
    // in-flight ガード・トーストもリセットする（前ターゲットの応答が新ターゲットに影響しないように）
    setProfile(null);
    setStatus('loading');
    setPosts([]);
    setCursor(null);
    setListDone(false);
    setListError(null);
    setToast(null);
    setLoadingMore(false);
    setFollowBusy(false);
    followBusyRef.current = false;
    loadingMoreRef.current = false;
    seenPostIds.current = new Set();
    // 前ターゲットの in-flight セットも破棄（同一 pid が新ターゲットに現れてもボタンが固まらないように）
    reactionInflight.current.clear();
    engageInflight.current.clear();
    setTarget({ provider: p, author: a });
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
              <button type="button" onClick={() => setNonce((n) => n + 1)}>再試行</button>
            </div>
          )}
          {status === 'unavailable' && <p className="empty">このユーザーは表示できません</p>}

          {profile && status === 'done' && (
            <>
              <div className="profile-header">
                {profile.bannerUrl && /^https?:\/\//.test(profile.bannerUrl) && (
                  <img className="profile-banner" src={profile.bannerUrl} alt="" />
                )}
                <div className="profile-id">
                  {profile.author.avatarUrl && /^https?:\/\//.test(profile.author.avatarUrl) ? (
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
                  {profile.url && /^https?:\/\//.test(profile.url) && (
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
            </>
          )}

          {/* 一覧は概要の成否と独立に表示する（§8.2「概要と一覧は別々に失敗を扱う」）。
              概要がエラーでも一覧が読めたら見せる。unavailable（削除・ブロック）は一覧も出さない */}
          {profileReadyOrListReady && (
            <>
              {listError && (
                <div className="banner error">
                  投稿一覧を読み込めませんでした（{listError}）{' '}
                  <button type="button" onClick={() => void retryList()}>再試行</button>
                </div>
              )}
              {!listDone && <p className="empty">読み込み中…</p>}
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
              {/* sentinel は一覧の表示時のみ（概要失敗時は loadMore を連発させない。§8.2） */}
              <div ref={sentinelRef} className="sentinel">
                {loadingMore && 'さらに読み込み中…'}
              </div>
            </>
          )}

          {toast && <div className="toast">{toast}</div>}
        </div>
      </div>
    </div>
  );
}
