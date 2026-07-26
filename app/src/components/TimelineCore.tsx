/**
 * TimelineCore: Source 群の fetch・ポーリング・時系列合成・描画の本体。
 * モバイルの Timeline（トップバー/FAB 付き）とデスクトップの Deck（カラム）の両方から再利用される。
 * ポーリング間隔はプロバイダ別（Misskey 15秒 / Bluesky 30秒。docs/deck-view-spec.md §3）。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { applyReaction } from '../lib/reactions';
import { withLike, withRenoteIncrement, withRepost } from '../lib/engagements';
import type { Post, Provider, Source } from '../../../shared/types';
import { PostCard } from './PostCard';

const TICK_MS = 15_000;
const POLL_MS: Record<Provider, number> = { misskey: 15_000, bluesky: 30_000, mastodon: 30_000 };
const PTR_THRESHOLD = 70;

export type TimelineCoreHandle = { refresh: () => Promise<void> };

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
    /** タッチの pull-to-refresh を有効化（モバイル向け。デッキでは無効） */
    pullToRefresh?: boolean;
    /** オフラインバナーを表示（モバイル向け。デッキでは各カラムが持つと冗長なため無効） */
    showOfflineBanner?: boolean;
    className?: string;
  }
>(function TimelineCore(
  { sources, justPosted, onReply, onQuote, interactive, badgeFor, pullToRefresh, showOfflineBanner, className },
  ref,
) {
  const [states, setStates] = useState<SourceState[]>(() => initStates(sources));
  const [refreshing, setRefreshing] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [pull, setPull] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const seenIds = useRef<Set<string>>(new Set());
  const statesRef = useRef(states);
  statesRef.current = states;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const touchStartY = useRef<number | null>(null);
  const reactionInflight = useRef<Set<string>>(new Set());
  const engageInflight = useRef<Set<string>>(new Set());
  const lastPollAt = useRef<Map<string, number>>(new Map());

  const patch = useCallback((key: string, fn: (s: SourceState) => SourceState) => {
    setStates((prev) => prev.map((s) => (keyOf(s.source) === key ? fn(s) : s)));
  }, []);

  // --- リアクションの楽観更新（docs/misskey-reaction-action-spec.md） ---
  // クリック直後にローカルパッチ、失敗時はスナップショットへロールバック＋トースト。1投稿 in-flight 1件。
  const toggleReaction = useCallback(
    async (post: Post, reaction?: string, emojiUrl?: string) => {
      const id = pid(post);
      if (typeof post.ref !== 'string' || reactionInflight.current.has(id)) return;
      const snapshot = statesRef.current;
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
        setStates(snapshot); // ロールバック
        setToast('リアクションに失敗しました');
      } finally {
        reactionInflight.current.delete(id);
      }
    },
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  /** 1投稿を全 Source 状態から横断パッチする */
  const patchPost = useCallback((id: string, fn: (p: Post) => Post) => {
    setStates((prev) => prev.map((s) => ({ ...s, posts: s.posts.map((p) => (pid(p) === id ? fn(p) : p)) })));
  }, []);

  // --- Like トグル（Bluesky。楽観更新 + 失敗時ロールバック） ---
  const toggleLike = useCallback(
    async (post: Post) => {
      if (post.provider !== 'bluesky') return;
      const postRef = post.ref as { uri?: string; cid?: string } | undefined;
      const id = pid(post);
      if (!postRef?.uri || !postRef?.cid || engageInflight.current.has(id)) return;
      engageInflight.current.add(id);
      const snapshot = statesRef.current;
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
        setStates(snapshot);
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
        const snapshot = statesRef.current;
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
          setStates(snapshot);
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
        const data = await api.timeline(st.source);
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
    void (async () => {
      await Promise.allSettled(
        sources.map(async (source) => {
          const key = keyOf(source);
          try {
            const data = await api.timeline(source);
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
    if (!st || st.loadingMore) return;
    patch(bestKey, (s) => ({ ...s, loadingMore: true }));
    try {
      const data = await api.timeline(st.source, st.cursor ?? undefined);
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
            const data = await api.timeline(st.source);
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

  // --- 新着を適用（各 Source の先頭に挿入＋先頭へスクロール） ---
  const applyPending = useCallback(() => {
    setStates((prev) =>
      prev.map((s) => {
        if (s.pending.length === 0) return s;
        for (const p of s.pending) seenIds.current.add(pid(p));
        return { ...s, posts: [...s.pending, ...s.posts], pending: [] };
      }),
    );
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // --- 手動更新 / pull-to-refresh ---
  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    await Promise.allSettled(
      statesRef.current
        .filter((s) => !s.authFailed)
        .map(async (st) => {
          const key = keyOf(st.source);
          try {
            const data = await api.timeline(st.source);
            const fresh = data.posts.filter((p) => !seenIds.current.has(pid(p)));
            for (const p of fresh) seenIds.current.add(pid(p));
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
    setRefreshing(false);
  }, [refreshing, patch, handleSourceError]);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

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
    if ((scrollRef.current?.scrollTop ?? 1) <= 0) touchStartY.current = e.touches[0].clientY;
    else touchStartY.current = null;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current == null) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    if (dy > 0 && (scrollRef.current?.scrollTop ?? 1) <= 0) setPull(Math.min(dy * 0.5, 120));
  };
  const onTouchEnd = () => {
    if (pull >= PTR_THRESHOLD) void refresh();
    setPull(0);
    touchStartY.current = null;
  };

  // --- 全 Source を時系列で合成（dedup 付き。初出 Source も保持し帰属バッジに使う） ---
  const merged = useMemo(() => {
    const map = new Map<string, { post: Post; skey: string }>();
    for (const s of states) {
      const sk = keyOf(s.source);
      for (const p of s.posts) {
        const k = pid(p);
        if (!map.has(k)) map.set(k, { post: p, skey: sk });
      }
    }
    return [...map.values()].toSorted(
      (a, b) => new Date(b.post.createdAt).getTime() - new Date(a.post.createdAt).getTime(),
    );
  }, [states]);

  const pendingCount = states.reduce((n, s) => n + s.pending.length, 0);
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

        {merged.map(({ post, skey }) => (
          <PostCard
            key={pid(post)}
            post={post}
            onReply={onReply}
            onQuote={onQuote}
            onReact={toggleReaction}
            onLike={interactive ? () => void toggleLike(post) : undefined}
            onRepost={interactive ? () => void toggleRepost(post) : undefined}
            badge={badgeFor?.(skey, post.provider)}
          />
        ))}

        {merged.length === 0 && errored.length === 0 && <p className="empty">読み込み中…</p>}

        <div ref={sentinelRef} className="sentinel">
          {loadingMore && hasMore && 'さらに読み込み中…'}
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
});
