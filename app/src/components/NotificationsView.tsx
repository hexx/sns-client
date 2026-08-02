/**
 * NotificationsView: 通知 View の fetch・ポーリング・時系列合成・描画の本体（docs/notifications-spec.md）。
 * - 通知 Source（kind: 'notifications'）群をプロバイダごとに /api/notifications で取得し、時系列合成する。
 * - ポーリング間隔は TimelineCore と同じプロバイダ別周期（misskey 15秒 / bluesky 30秒。§9）。
 * - 既読化は「表示中の View に新着が取り込まれた瞬間、およびアクティブになった瞬間」の全既読（§5）。
 *   非アクティブ中は一覧も取得するが既読化しない（未読数はタブバッジに出す）。
 * - 新着ピル・区切り線（unread-divider）は使わない（§5）。無限スクロールは §8。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { Author, Notification, Post, Provider, Source } from '../../../shared/types';
import { NotificationCard } from './NotificationCard';

const TICK_MS = 15_000;
const POLL_MS: Record<Provider, number> = { misskey: 15_000, bluesky: 30_000, mastodon: 30_000, mixi2: 30_000, nostr: 30_000 };

const INITIAL_UNREAD: Record<NotifProvider, number> = { bluesky: 0, misskey: 0 };

type NotifProvider = 'bluesky' | 'misskey';

type ProviderState = {
  provider: NotifProvider;
  notifications: Notification[];
  cursor: string | null;
  loadingMore: boolean;
  error: string | null;
  authFailed: boolean;
};

function nid(n: Notification): string {
  return `${n.provider}:${n.id}`;
}

function initState(provider: NotifProvider): ProviderState {
  return { provider, notifications: [], cursor: null, loadingMore: false, error: null, authFailed: false };
}

export function NotificationsView({
  sources,
  active,
  onOpenThread,
  onOpenProfile,
  onPendingCountChange,
  className,
}: {
  sources: Source[];
  /** 表示中（モバイル: アクティブタブ / デッキ: 常に true）。表示中は新着を既読化する（§5） */
  active: boolean;
  onOpenThread?: (p: Post) => void;
  /** actor（アバター・名前）のクリックでプロフィールを開く（docs/profile-view-spec.md §8.1） */
  onOpenProfile?: (provider: Provider, a: Author) => void;
  /** 未読数の変化を通知（スマホ UI のタブバッジ用。docs/mobile-paging-spec.md §4.4 と同じ受け口） */
  onPendingCountChange?: (count: number) => void;
  className?: string;
}) {
  // 通知 Source をプロバイダごとに1状態へ集約（同一プロバイダの重複 Source は先勝ち）
  const providers = useMemo<NotifProvider[]>(() => {
    const seen = new Set<NotifProvider>();
    const out: NotifProvider[] = [];
    for (const s of sources) {
      if (s.provider === 'bluesky' || s.provider === 'misskey') {
        if (!seen.has(s.provider)) {
          seen.add(s.provider);
          out.push(s.provider);
        }
      }
    }
    return out;
  }, [sources]);

  const [states, setStates] = useState<ProviderState[]>(() => providers.map((p) => initState(p)));
  const [unread, setUnread] = useState<Record<NotifProvider, number>>(INITIAL_UNREAD);
  const [loaded, setLoaded] = useState(false); // 初回読み込み完了（空でも「通知はありません」を出せるように）

  const statesRef = useRef(states);
  statesRef.current = states;
  const lastPollAt = useRef<Map<NotifProvider, number>>(new Map());
  const loadingKeys = useRef<Set<NotifProvider>>(new Set());
  const markReadInFlight = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // sources 変化（View 編集）で状態を作り直す
  useEffect(() => {
    setStates(providers.map((p) => initState(p)));
    lastPollAt.current = new Map();
    setUnread(INITIAL_UNREAD);
    setLoaded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  const patch = useCallback((provider: NotifProvider, fn: (s: ProviderState) => ProviderState) => {
    setStates((prev) => prev.map((s) => (s.provider === provider ? fn(s) : s)));
  }, []);

  const handleError = useCallback(
    (provider: NotifProvider, e: unknown) => {
      if (e instanceof ApiError && (e.permanent || e.status === 401)) {
        patch(provider, (s) => ({ ...s, authFailed: true, error: '認証失敗' }));
      } else if (e instanceof ApiError && e.status === 503) {
        patch(provider, (s) => ({ ...s, authFailed: true, error: '未設定' }));
      } else {
        patch(provider, (s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [patch],
  );

  /** 全既読（表示中の View の既読化。§5。失敗はログのみで次回ポーリングに委ねる）。同時発火は1つに抑える */
  const markRead = useCallback(async () => {
    if (markReadInFlight.current) return;
    markReadInFlight.current = true;
    try {
      await api.markNotificationsRead();
      setUnread(INITIAL_UNREAD);
    } catch (e) {
      console.error('[notifications] mark read failed', e);
    } finally {
      markReadInFlight.current = false;
    }
  }, []);

  /** 単一プロバイダの取得（初回・再試行・既読化後の即時反映に使う） */
  const fetchProvider = useCallback(
    async (provider: NotifProvider, cursor?: string) => {
      const data = await api.notifications(provider, cursor);
      return data;
    },
    [],
  );
  /** 初回読み込み（プロバイダごとに独立。片方失敗しても他方は表示） */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.allSettled(
        providers.map(async (provider) => {
          // 開始時点で lastPollAt を記録し、active エフェクトの即時 checkNew と重複取得しないようにする
          lastPollAt.current.set(provider, Date.now());
          try {
            const data = await fetchProvider(provider);
            if (cancelled) return;
            lastPollAt.current.set(provider, Date.now());
            patch(provider, (s) => ({
              ...s,
              notifications: data.notifications,
              cursor: data.nextCursor,
              error: null,
              authFailed: false,
            }));
            setUnread((prev) => ({ ...prev, [provider]: data.unreadCount }));
          } catch (e) {
            if (!cancelled) handleError(provider, e);
          }
        }),
      );
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [providers, patch, handleError, fetchProvider]);

  // --- 新着チェック（プロバイダ別間隔。一覧は常に差し替え、既読化は表示中のみ） ---
  const checkNew = useCallback(async () => {
    if (document.hidden || !navigator.onLine) return;
    const now = Date.now();
    await Promise.allSettled(
      statesRef.current
        .filter((s) => !s.authFailed)
        .filter((s) => now - (lastPollAt.current.get(s.provider) ?? 0) >= POLL_MS[s.provider])
        .map(async (st) => {
          const provider = st.provider;
          lastPollAt.current.set(provider, now);
          try {
            const data = await fetchProvider(provider);
            // 全件差し替えではなく、新着を先頭にマージする（loadMore で追記した古い履歴を消さない。dedup 付き）
            patch(provider, (s) => {
              const fresh = data.notifications.filter((n) => !s.notifications.some((m) => nid(m) === nid(n)));
              return {
                ...s,
                notifications: fresh.length > 0 ? [...fresh, ...s.notifications] : s.notifications,
                cursor: data.nextCursor ?? s.cursor,
                error: null,
              };
            });
            setUnread((prev) => ({ ...prev, [provider]: data.unreadCount }));
            // 表示中の View は「見えているものは既読」: 新着が届いた時点で全既読（§5）
            if (activeRef.current && data.unreadCount > 0) void markRead();
          } catch (e) {
            // 認証失敗/未設定は表面化（当該プロバイダのポーリング停止）。一時的エラーは黙ってスキップ
            if (e instanceof ApiError && (e.permanent || e.status === 401 || e.status === 503)) {
              handleError(provider, e);
            }
          }
        }),
    );
  }, [patch, handleError, fetchProvider, markRead]);

  useEffect(() => {
    const t = setInterval(() => void checkNew(), TICK_MS);
    return () => clearInterval(t);
  }, [checkNew]);

  // --- アクティブになった瞬間: 既読化 + 即時再取得（§5） ---
  useEffect(() => {
    if (!active) return;
    void markRead();
    void checkNew();
  }, [active, markRead, checkNew]);

  // --- 追加読み込み: 最古の表示通知が新しい側のプロバイダをページング（§8） ---
  const loadMore = useCallback(async () => {
    let best: ProviderState | null = null;
    let bestTime = -Infinity;
    for (const s of statesRef.current) {
      if (!s.cursor || s.notifications.length === 0 || s.authFailed) continue;
      const t = new Date(s.notifications[s.notifications.length - 1].createdAt).getTime();
      if (t > bestTime) {
        bestTime = t;
        best = s;
      }
    }
    if (!best || loadingKeys.current.has(best.provider)) return;
    loadingKeys.current.add(best.provider);
    patch(best.provider, (s) => ({ ...s, loadingMore: true }));
    try {
      const data = await fetchProvider(best.provider, best.cursor ?? undefined);
      patch(best.provider, (s) => ({
        ...s,
        notifications: [
          ...s.notifications,
          ...data.notifications.filter((n) => !s.notifications.some((m) => nid(m) === nid(n))),
        ],
        cursor: data.nextCursor,
        loadingMore: false,
      }));
    } catch (e) {
      patch(best.provider, (s) => ({ ...s, loadingMore: false }));
      handleError(best.provider, e);
    } finally {
      loadingKeys.current.delete(best.provider);
    }
  }, [patch, handleError, fetchProvider]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // --- 単一プロバイダの再試行 ---
  const retryProvider = useCallback(
    async (provider: NotifProvider) => {
      patch(provider, (s) => ({ ...s, error: null, authFailed: false }));
      try {
        const data = await fetchProvider(provider);
        lastPollAt.current.set(provider, Date.now());
        patch(provider, (s) => ({
          ...s,
          notifications: data.notifications,
          cursor: data.nextCursor,
          error: null,
          authFailed: false,
        }));
        setUnread((prev) => ({ ...prev, [provider]: data.unreadCount }));
      } catch (e) {
        handleError(provider, e);
      }
    },
    [patch, handleError, fetchProvider],
  );

  // --- 全プロバイダを時系列で合成（dedup 付き） ---
  const merged = useMemo(() => {
    const map = new Map<string, Notification>();
    for (const s of states) {
      for (const n of s.notifications) map.set(nid(n), n);
    }
    return [...map.values()].toSorted(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [states]);

  const totalUnread = unread.bluesky + unread.misskey;

  useEffect(() => {
    onPendingCountChange?.(totalUnread);
  }, [onPendingCountChange, totalUnread]);

  const errored = states.filter((s) => s.error);
  const loadingMore = states.some((s) => s.loadingMore);

  return (
    <div className={`timeline-core notif-view${className ? ` ${className}` : ''}`}>
      {errored.map((s) => (
        <div className="banner error" key={s.provider}>
          {s.provider}: {s.error}
          {s.authFailed ? null : (
            <button onClick={() => void retryProvider(s.provider)}>再試行</button>
          )}
        </div>
      ))}

      <div className="scroll">
        {merged.map((n) => (
          <NotificationCard key={nid(n)} notification={n} onOpenThread={onOpenThread} onOpenProfile={onOpenProfile} />
        ))}

        {merged.length === 0 && errored.length === 0 && (
          <p className="empty">{loaded ? '通知はありません' : '読み込み中…'}</p>
        )}

        <div ref={sentinelRef} className="sentinel">
          {loadingMore && 'さらに読み込み中…'}
        </div>
      </div>
    </div>
  );
}
