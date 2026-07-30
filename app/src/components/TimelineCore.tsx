/**
 * TimelineCore: Source 群の fetch・ポーリング・時系列合成・描画の本体。
 * モバイルの Timeline（トップバー/FAB 付き）とデスクトップの Deck（カラム）の両方から再利用される。
 * ポーリング間隔はプロバイダ別（Misskey 15秒 / Bluesky 30秒。docs/deck-view-spec.md §3）。
 * 新着の取り込み後は未読強調＋区切り線「新着はここまで」を表示し、
 * 区切り線をスクロールで通過したら（可視領域の上部から完全に外れたら）既読クリアする（docs/unread-divider-spec.md §3.4）。
 * 追加取り込みは未読セットを差し替える（同 §3.3。取り込みは常に利用者の明示的操作のため）。
 */
import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { fetchTimeline } from '../lib/timeline';
import { applyReaction } from '../lib/reactions';
import { withLike, withRenoteIncrement, withRepost } from '../lib/engagements';
import type { Post, Provider, Source } from '../../../shared/types';
import { PostCard } from './PostCard';

const TICK_MS = 15_000;
const POLL_MS: Record<Provider, number> = { misskey: 15_000, bluesky: 30_000, mastodon: 30_000, mixi2: 30_000, nostr: 30_000 };
const PTR_THRESHOLD = 70;

export type TimelineCoreHandle = { refresh: () => Promise<void>; applyPending: () => void };

function keyOf(s: Source): string {
  return `${s.provider}:${s.kind}:${s.id ?? ''}`;
}
/** プロバイダをまたぐ id 衝突を避けるためのグローバル識別子 */
function pid(p: Post): string {
  return `${p.provider}:${p.id}`;
}

type SourceState = {
  source: Source;
  posts: Post[];
  pending: Post[];
  cursor: string | null;
  loadingMore: boolean;
  error: string | null;
  authFailed: boolean; // 恒久認証失敗/未設定 → この Source のポーリングを停止
};

function initStates(sources: Source[]): SourceState[] {
  return sources.map((source) => ({
    source,
    posts: [],
    pending: [],
    cursor: null,
    loadingMore: false,
    error: null,
    authFailed: false,
  }));
}

export const TimelineCore = forwardRef<
  TimelineCoreHandle,
  {
    sources: Source[];
    justPosted?: Post | null;
    onReply?: (p: Post) => void;
    onQuote?: (p: Post) => void;
    /** Like/リポストボタンを有効化（デッキ向け。docs/deck-view-spec.md §6） */
    interactive?: boolean;
    /** 帰属バッジの生成（sourceKey と provider から「Misskey · 技術リスト」のような文字列） */
    badgeFor?: (sourceKey: string, provider: Provider) => string | undefined;
    /** 手動更新の開始/終了通知（モバイルの更新ボタン表示用） */
    onRefreshingChange?: (refreshing: boolean) => void;
    /** タッチの pull-to-refresh を有効化（モバイル向け。デッキでは無効） */
    pullToRefresh?: boolean;
    /** 未取り込み新着数の変化を通知（スマホ UI のタブバッジ用。docs/mobile-paging-spec.md §4.4） */
    onPendingCountChange?: (count: number) => void;
    /** オフラインバナーを表示（モバイル向け。デッキでは各カラムが持つと冗長なため無効） */
    showOfflineBanner?: boolean;
    className?: string;
  }
>(function TimelineCore(
  {
    sources,
    justPosted,
    onReply,
    onQuote,
    interactive,
    badgeFor,
    onRefreshingChange,
    pullToRefresh,
    showOfflineBanner,
    onPendingCountChange,
    className,
  },
  ref,
) {
  const [states, setStates] = useState<SourceState[]>(() => initStates(sources));
  const [refreshing, setRefreshing] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [pull, setPull] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  /** 未読投稿のグローバル id セット（docs/unread-divider-spec.md §3。セッション内のみ） */
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());

  const seenIds = useRef<Set<string>>(new Set());
  const statesRef = useRef(states);
  statesRef.current = states;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const touchStartY = useRef<number | null>(null);
  const touchStartX = useRef<number | null>(null);
  const reactionInflight = useRef<Set<string>>(new Set());
  const engageInflight = useRef<Set<string>>(new Set());
  const loadingKeys = useRef<Set<string>>(new Set());
  const refreshingRef = useRef(false);
  const lastPollAt = useRef<Map<string, number>>(new Map());
  const dividerRef = useRef<HTMLDivElement | null>(null);

  const patch = useCallback((key: string, fn: (s: SourceState) => SourceState) => {
    setStates((prev) => prev.map((s) => (keyOf(s.source) === key ? fn(s) : s)));
  }, []);

  /** 1投稿を全 Source 状態から横断パッチする */
  const patchPost = useCallback((id: string, fn: (p: Post) => Post) => {
    setStates((prev) => prev.map((s) => ({ ...s, posts: s.posts.map((p) => (pid(p) === id ? fn(p) : p)) })));
  }, []);

  // --- リアクションの楽観更新（docs/misskey-reaction-action-spec.md） ---
  // クリック直後にローカルパッチ、失敗時は当該投稿をロールバック＋トースト。1投稿 in-flight 1件。
  const toggleReaction = useCallback(
    async (post: Post, reaction?: string, emojiUrl?: string) => {
      const id = pid(post);
      if (typeof post.ref !== 'string' || reactionInflight.current.has(id)) return;
      // 失敗時は当該投稿だけを更新前に戻す（全状態スナップショットだと並行するポーリング等を上書きするため）
      const original = post;
      reactionInflight.current.add(id);
      setStates((prev) =>
        prev.map((s) => ({
          ...s,
          posts: s.posts.map((p) => (pid(p) === id ? applyReaction(p, reaction, emojiUrl) : p)),
        })),
      );
      try {
        await api.react(post.ref, reaction);
      } catch {
        patchPost(id, () => original); // ロールバック
        setToast('リアクションに失敗しました');
      } finally {
        reactionInflight.current.delete(id);
      }
    },
    [patchPost],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Like トグル（Bluesky。楽観更新 + 失敗時ロールバック） ---
  const toggleLike = useCallback(
    async (post: Post) => {
      if (post.provider !== 'bluesky') return;
      const postRef = post.ref as { uri?: string; cid?: string } | undefined;
      const id = pid(post);
      if (!postRef?.uri || !postRef?.cid || engageInflight.current.has(id)) return;
      engageInflight.current.add(id);
      const original = post;
      const liked = Boolean(post.viewer?.likeUri);
      patchPost(id, (p) => withLike(p, !liked, liked ? undefined : `pending:${id}`));
      try {
        if (liked) {
          await api.unlike(post.viewer?.likeUri as string);
        } else {
          const res = await api.like(postRef.uri, postRef.cid);
          if (res.recordUri) patchPost(id, (p) => ({ ...p, viewer: { ...p.viewer, likeUri: res.recordUri } }));
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

  // --- リポスト（bsky=トグル / misskey=作成のみ。docs/deck-view-spec.md §6） ---
  const toggleRepost = useCallback(
    async (post: Post) => {
      const id = pid(post);
      if (engageInflight.current.has(id)) return;
      engageInflight.current.add(id);
      if (post.provider === 'bluesky') {
        const postRef = post.ref as { uri?: string; cid?: string } | undefined;
        if (!postRef?.uri || !postRef?.cid) {
          engageInflight.current.delete(id);
          return;
        }
        const original = post;
        const reposted = Boolean(post.viewer?.repostUri);
        patchPost(id, (p) => withRepost(p, !reposted, reposted ? undefined : `pending:${id}`));
        try {
          if (reposted) {
            await api.unrepost(post.viewer?.repostUri as string);
          } else {
            const res = await api.repost('bluesky', postRef);
            if (res.recordUri) patchPost(id, (p) => ({ ...p, viewer: { ...p.viewer, repostUri: res.recordUri } }));
          }
        } catch {
          patchPost(id, () => original);
          setToast('リポストに失敗しました');
        } finally {
          engageInflight.current.delete(id);
        }
        return;
      }
      if (post.provider === 'misskey' && typeof post.ref === 'string') {
        try {
          await api.repost('misskey', post.ref);
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

  const handleSourceError = useCallback(
    (key: string, e: unknown) => {
      if (e instanceof ApiError && (e.permanent || e.status === 401)) {
        patch(key, (s) => ({ ...s, authFailed: true, error: '認証失敗' }));
      } else if (e instanceof ApiError && e.status === 503) {
        patch(key, (s) => ({ ...s, authFailed: true, error: '未設定' }));
      } else {
        patch(key, (s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [patch],
  );

  // --- 単一 Source の再試行（失敗した Source だけ再取得。他 Source の読込済み内容は保持） ---
  const retrySource = useCallback(
    async (key: string) => {
      const st = statesRef.current.find((s) => keyOf(s.source) === key);
      if (!st) return;
      patch(key, (s) => ({ ...s, error: null, authFailed: false }));
      try {
        const data = await fetchTimeline(st.source);
        for (const p of data.posts) seenIds.current.add(pid(p));
        patch(key, (s) => ({ ...s, posts: data.posts, pending: [], cursor: data.nextCursor, error: null, authFailed: false }));
      } catch (e) {
        handleSourceError(key, e);
      }
    },
    [patch, handleSourceError],
  );

  // --- 初回読み込み（Source ごとに独立。片方失敗しても他方は表示） ---
  useEffect(() => {
    let cancelled = false;
    setStates(initStates(sources));
    seenIds.current = new Set();
    lastPollAt.current = new Map();
    setUnreadIds(new Set());
    void (async () => {
      await Promise.allSettled(
        sources.map(async (source) => {
          const key = keyOf(source);
          try {
            const data = await fetchTimeline(source);
            if (cancelled) return;
            for (const p of data.posts) seenIds.current.add(pid(p));
            patch(key, (s) => ({ ...s, posts: data.posts, pending: [], cursor: data.nextCursor, error: null, authFailed: false }));
          } catch (e) {
            if (!cancelled) handleSourceError(key, e);
          }
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [sources, patch, handleSourceError]);

  // --- 自分が投稿したものを該当プロバイダの先頭に反映 ---
  useEffect(() => {
    if (!justPosted) return;
    seenIds.current.add(pid(justPosted));
    setStates((prev) =>
      prev.map((s) =>
        s.source.provider === justPosted.provider && !s.posts.some((p) => pid(p) === pid(justPosted))
          ? { ...s, posts: [justPosted, ...s.posts] }
          : s,
      ),
    );
  }, [justPosted]);

  // --- 追加読み込み: 「最古の表示投稿が新しい側の Source」をページング ---
  const loadMore = useCallback(async () => {
    let bestKey: string | null = null;
    let bestTime = -Infinity;
    for (const s of statesRef.current) {
      if (!s.cursor || s.posts.length === 0 || s.authFailed) continue;
      const t = new Date(s.posts[s.posts.length - 1].createdAt).getTime();
      if (t > bestTime) {
        bestTime = t;
        bestKey = keyOf(s.source);
      }
    }
    if (!bestKey) return;
    const st = statesRef.current.find((s) => keyOf(s.source) === bestKey);
    // statesRef は再描画まで更新されないため、ref で in-flight を管理し連打競合を防ぐ
    if (!st || loadingKeys.current.has(bestKey)) return;
    loadingKeys.current.add(bestKey);
    patch(bestKey, (s) => ({ ...s, loadingMore: true }));
    try {
      const data = await fetchTimeline(st.source, st.cursor ?? undefined);
      for (const p of data.posts) seenIds.current.add(pid(p));
      patch(bestKey, (s) => ({
        ...s,
        posts: [...s.posts, ...data.posts],
        cursor: data.nextCursor,
        loadingMore: false,
        error: null,
      }));
    } catch (e) {
      patch(bestKey, (s) => ({ ...s, loadingMore: false }));
      handleSourceError(bestKey, e);
    } finally {
      loadingKeys.current.delete(bestKey);
    }
  }, [patch, handleSourceError]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // --- 新着チェック（全 Source 横断。自動挿入しない。プロバイダ別間隔） ---
  const checkNew = useCallback(async () => {
    if (document.hidden || !navigator.onLine) return;
    const now = Date.now();
    await Promise.allSettled(
      statesRef.current
        .filter((s) => !s.authFailed)
        .filter((s) => now - (lastPollAt.current.get(keyOf(s.source)) ?? 0) >= POLL_MS[s.source.provider])
        .map(async (st) => {
          const key = keyOf(st.source);
          lastPollAt.current.set(key, now);
          try {
            const data = await fetchTimeline(st.source);
            const fresh = data.posts.filter((p) => !seenIds.current.has(pid(p)));
            if (fresh.length > 0) {
              patch(key, (s) => ({
                ...s,
                pending: [...s.pending, ...fresh.filter((p) => !s.pending.some((q) => pid(q) === pid(p)))],
                cursor: data.nextCursor ?? s.cursor,
              }));
            }
          } catch (e) {
            // 認証失敗/未設定は表面化（当該 Source のポーリング停止）。一時的エラーは黙ってスキップ（バックオフ相当）
            if (e instanceof ApiError && (e.permanent || e.status === 401 || e.status === 503)) {
              handleSourceError(key, e);
            }
          }
        }),
    );
  }, [patch, handleSourceError]);

  useEffect(() => {
    const t = setInterval(() => void checkNew(), TICK_MS);
    return () => clearInterval(t);
  }, [checkNew]);

  // --- 既読クリア（docs/unread-divider-spec.md §3.4） ---
  /** 区切り線が可視領域の上部から完全に外れた瞬間、未読セットを即座に破棄する（フェードなし） */
  const clearUnread = useCallback(() => {
    setUnreadIds(new Set());
  }, []);

  // --- 新着を適用（各 Source の先頭に挿入＋未読マーク＋先頭へスクロール） ---
  const applyPending = useCallback(() => {
    const newUnread = statesRef.current.flatMap((s) => s.pending).map(pid);
    if (newUnread.length === 0) return;
    for (const id of newUnread) seenIds.current.add(id);
    setStates((prev) =>
      prev.map((s) => (s.pending.length === 0 ? s : { ...s, posts: [...s.pending, ...s.posts], pending: [] })),
    );
    // 追加取り込みは未読の差し替え: 旧セットを破棄し、今回取り込んだ分だけで新設する（§3.3）
    setUnreadIds(new Set(newUnread));
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // --- 手動更新 / pull-to-refresh ---
  const refresh = useCallback(async () => {
    // 状態は再描画まで反映されないため ref でガード（PTR と imperative handle の同時発火競合を防ぐ）
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    onRefreshingChange?.(true);
    const freshIds: string[] = [];
    await Promise.allSettled(
      statesRef.current
        .filter((s) => !s.authFailed)
        .map(async (st) => {
          const key = keyOf(st.source);
          try {
            const data = await fetchTimeline(st.source);
            const fresh = data.posts.filter((p) => !seenIds.current.has(pid(p)));
            for (const p of fresh) {
              seenIds.current.add(pid(p));
              freshIds.push(pid(p));
            }
            patch(key, (s) => ({
              ...s,
              posts: fresh.length > 0 ? [...fresh, ...s.posts] : s.posts,
              cursor: data.nextCursor ?? s.cursor,
              error: null,
            }));
          } catch (e) {
            handleSourceError(key, e);
          }
        }),
    );
    // 手動更新の新着も未読マーク（単一ルール。docs/unread-divider-spec.md §3.1 / §4.3）。
    // 1件以上あれば差し替え（§3.3）、0件なら既存の未読をそのまま維持する。
    if (freshIds.length > 0) {
      setUnreadIds(new Set(freshIds));
    }
    refreshingRef.current = false;
    setRefreshing(false);
    onRefreshingChange?.(false);
  }, [patch, handleSourceError, onRefreshingChange]);

  useImperativeHandle(ref, () => ({ refresh, applyPending }), [refresh, applyPending]);

  // --- オンライン/オフライン ---
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // --- pull-to-refresh（タッチ。モバイル向け） ---
  const onTouchStart = (e: React.TouchEvent) => {
    if (!pullToRefresh) return;
    if ((scrollRef.current?.scrollTop ?? 1) <= 0) {
      touchStartY.current = e.touches[0].clientY;
      touchStartX.current = e.touches[0].clientX;
    } else {
      touchStartY.current = null;
      touchStartX.current = null;
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current == null) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    const adx = Math.abs(e.touches[0].clientX - (touchStartX.current ?? e.touches[0].clientX));
    // 縦優勢のジェスチャのみ PTR とする（横スワイプページングとの調停。docs/mobile-paging-spec.md §5）
    if (dy > 0 && dy > adx && (scrollRef.current?.scrollTop ?? 1) <= 0) setPull(Math.min(dy * 0.5, 120));
  };
  const onTouchEnd = () => {
    if (pull >= PTR_THRESHOLD) void refresh();
    setPull(0);
    touchStartY.current = null;
    touchStartX.current = null;
  };

  // --- 全 Source を時系列で合成（dedup 付き。帰属バッジ用の Source も保持） ---
  // 同一投稿が複数 Source に現れる場合は home より list/antenna/feed を優先する（由来が具体的になるため）
  const merged = useMemo(() => {
    const map = new Map<string, { post: Post; skey: string; kind: string }>();
    for (const s of states) {
      const sk = keyOf(s.source);
      for (const p of s.posts) {
        const k = pid(p);
        const prev = map.get(k);
        if (!prev || (prev.kind === 'home' && s.source.kind !== 'home')) {
          map.set(k, { post: p, skey: sk, kind: s.source.kind });
        }
      }
    }
    return [...map.values()].toSorted(
      (a, b) => new Date(b.post.createdAt).getTime() - new Date(a.post.createdAt).getTime(),
    );
  }, [states]);

  const pendingCount = states.reduce((n, s) => n + s.pending.length, 0);

  useEffect(() => {
    onPendingCountChange?.(pendingCount);
  }, [onPendingCountChange, pendingCount]);

  // --- 区切り線の位置: 最古の未読投稿の直下（docs/unread-divider-spec.md §3.2） ---
  // merged は createdAt 降順なので、末尾から走査して最初に見つかった未読が最古。
  // 複数 Source マージのタイミング差で未読が既読の間に混ざることがあるため、
  // 区切り線は境界の目印、投稿単位の強調が未読表現の本体になる。
  const dividerIndex = useMemo(() => {
    if (unreadIds.size === 0) return -1;
    for (let i = merged.length - 1; i >= 0; i--) {
      if (unreadIds.has(pid(merged[i].post))) return i;
    }
    return -1;
  }, [merged, unreadIds]);

  // 区切り線が可視領域の上部から完全に外れたら既読クリア（§3.4。root はこのタイムラインのスクロール容器）。
  // 「上端方向への退出」のみ判定する: 上方向オーバーバウンスで下端から一時的に外れた場合は発火しない。
  useEffect(() => {
    const el = dividerRef.current;
    if (!el || dividerIndex < 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const rootTop = e.rootBounds?.top ?? 0;
          if (!e.isIntersecting && e.boundingClientRect.bottom <= rootTop) {
            clearUnread();
            break;
          }
        }
      },
      { root: scrollRef.current },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [dividerIndex, clearUnread]);
  const loadingMore = states.some((s) => s.loadingMore);
  const errored = states.filter((s) => s.error);
  const hasMore = states.some((s) => s.cursor && s.posts.length > 0 && !s.authFailed);

  return (
    <div className={`timeline-core${className ? ` ${className}` : ''}`}>
      {showOfflineBanner && !online && <div className="banner offline">オフライン — 最後のキャッシュを表示中</div>}
      {errored.map((s) => (
        <div className="banner error" key={keyOf(s.source)}>
          {s.source.provider}: {s.error}
          {s.authFailed ? null : <button onClick={() => void retrySource(keyOf(s.source))}>再試行</button>}
        </div>
      ))}

      {pendingCount > 0 && (
        <button className="new-pill" onClick={applyPending}>
          新着 {pendingCount} 件
        </button>
      )}

      <div
        className="scroll"
        ref={scrollRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {(pull > 0 || refreshing) && (
          <div className="ptr" style={{ height: refreshing ? 40 : pull }}>
            {refreshing || pull >= PTR_THRESHOLD ? '⟳ 更新' : '↓ 引っ張って更新'}
          </div>
        )}

        {merged.map(({ post, skey }, i) => {
          // nostr は読み取り専用：返信/引用/いいね/リポストの操作系をすべて隠す（§5.3）
          const readOnly = post.provider === 'nostr';
          const id = pid(post);
          const unread = unreadIds.has(id);
          return (
            <Fragment key={id}>
              <PostCard
                post={post}
                onReply={readOnly ? undefined : onReply}
                onQuote={readOnly ? undefined : onQuote}
                onReact={readOnly ? undefined : toggleReaction}
                onLike={interactive && !readOnly ? () => void toggleLike(post) : undefined}
                onRepost={interactive && !readOnly ? () => void toggleRepost(post) : undefined}
                badge={badgeFor?.(skey, post.provider)}
                unread={unread}
              />
              {i === dividerIndex && (
                <div ref={dividerRef} className="unread-divider">
                  新着はここまで
                </div>
              )}
            </Fragment>
          );
        })}

        {merged.length === 0 && errored.length === 0 && <p className="empty">読み込み中…</p>}

        <div ref={sentinelRef} className="sentinel">
          {loadingMore && hasMore && 'さらに読み込み中…'}
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
});
