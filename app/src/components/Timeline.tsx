import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Post } from '../../../shared/types';
import { PostCard } from './PostCard';

const POLL_MS = 75_000;
const PTR_THRESHOLD = 70;

export function Timeline({
  onCompose,
  onReply,
  onQuote,
  justPosted,
}: {
  onCompose: () => void;
  onReply: (p: Post) => void;
  onQuote: (p: Post) => void;
  justPosted: Post | null;
}) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState<Post[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [pull, setPull] = useState(0); // pull-to-refresh の引っ張り量(px)

  const seenIds = useRef<Set<string>>(new Set());
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const touchStartY = useRef<number | null>(null);

  // --- 初回読み込み ---
  const loadInitial = useCallback(async () => {
    setError(null);
    try {
      const data = await api.timeline();
      seenIds.current = new Set(data.posts.map((p) => p.id));
      setPosts(data.posts);
      setCursor(data.nextCursor);
      setPending([]);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  // --- 自分が投稿したものを先頭に反映 ---
  useEffect(() => {
    if (!justPosted) return;
    seenIds.current.add(justPosted.id);
    setPosts((prev) => (prev.some((p) => p.id === justPosted.id) ? prev : [justPosted, ...prev]));
  }, [justPosted]);

  // --- 追加読み込み（無限スクロール） ---
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await api.timeline(cursor);
      for (const p of data.posts) seenIds.current.add(p.id);
      setPosts((prev) => [...prev, ...data.posts]);
      setCursor(data.nextCursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // --- 新着チェック（自動挿入しない） ---
  const checkNew = useCallback(async () => {
    if (document.hidden || !navigator.onLine) return;
    try {
      const data = await api.timeline();
      const fresh = data.posts.filter((p) => !seenIds.current.has(p.id));
      if (fresh.length > 0) setPending(fresh);
    } catch {
      /* ポーリング失敗は黙ってスキップ（バックオフ相当） */
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => void checkNew(), POLL_MS);
    return () => clearInterval(t);
  }, [checkNew]);

  // --- 新着を適用（先頭に挿入＋先頭へスクロール） ---
  const applyPending = useCallback(() => {
    setPending((fresh) => {
      if (fresh.length === 0) return fresh;
      for (const p of fresh) seenIds.current.add(p.id);
      setPosts((prev) => [...fresh, ...prev]);
      return [];
    });
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // --- 手動更新 / pull-to-refresh ---
  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const data = await api.timeline();
      const fresh = data.posts.filter((p) => !seenIds.current.has(p.id));
      for (const p of fresh) seenIds.current.add(p.id);
      if (fresh.length > 0) setPosts((prev) => [...fresh, ...prev]);
      setCursor(data.nextCursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

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

  // --- pull-to-refresh（タッチ） ---
  const onTouchStart = (e: React.TouchEvent) => {
    if ((scrollRef.current?.scrollTop ?? 1) <= 0) touchStartY.current = e.touches[0].clientY;
    else touchStartY.current = null;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current == null) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    if (dy > 0 && (scrollRef.current?.scrollTop ?? 1) <= 0) {
      setPull(Math.min(dy * 0.5, 120)); // 抵抗
    }
  };
  const onTouchEnd = () => {
    if (pull >= PTR_THRESHOLD) void refresh();
    setPull(0);
    touchStartY.current = null;
  };

  return (
    <div className="timeline-root">
      <header className="topbar">
        <h1>SNS Client</h1>
        <button className="refresh-btn" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? '更新中…' : '更新'}
        </button>
      </header>

      {!online && <div className="banner offline">オフライン — 最後のキャッシュを表示中</div>}
      {error && (
        <div className="banner error">
          エラー: {error} <button onClick={() => void loadInitial()}>再試行</button>
        </div>
      )}

      {pending.length > 0 && (
        <button className="new-pill" onClick={applyPending}>
          新着 {pending.length} 件
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

        {posts.map((p) => (
          <PostCard key={p.id} post={p} onReply={onReply} onQuote={onQuote} />
        ))}

        {posts.length === 0 && !error && <p className="empty">読み込み中…</p>}

        <div ref={sentinelRef} className="sentinel">
          {loadingMore && 'さらに読み込み中…'}
        </div>
      </div>

      <button className="fab" onClick={onCompose} aria-label="投稿">
        ✏️
      </button>
    </div>
  );
}
