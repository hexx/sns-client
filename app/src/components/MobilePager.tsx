/**
 * MobilePager: スマホ（<1024px）UI（docs/mobile-paging-spec.md、ADR-0010）。
 * 全 View を横並びページとして常時マウントし（ポーリング・スクロール位置・未取り込み新着を保持）、
 * 横スワイプで隣接 View、上部タブストリップのタップで任意 View へ移動する。
 * 新着は「アクティブページはピル・非アクティブはタブバッジ」の二層で通知する（§4.4）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TimelineCore } from './TimelineCore';
import { useBadgeFor } from '../lib/sourceLabels';
import type { Post, View } from '../../../shared/types';

// docs/mobile-paging-spec.md §5 のジェスチャ調停パラメータ（数値は目安。操作感で調整可）
const AXIS_SLOP = 8; // 軸決定のスロップ（px）
const SWIPE_DISTANCE_RATIO = 0.25; // ページ切替の距離閾値（画面幅比）
const FLICK_VELOCITY = 0.5; // フリック速度閾値（px/ms）
const EDGE_RESISTANCE = 0.3; // 先頭/末尾ページでのラバーバンド減衰

type Gesture = {
  x0: number;
  y0: number;
  t0: number;
  axis: 'x' | 'y' | null;
  lastX: number;
};

export function MobilePager({
  views,
  activeViewId,
  onSwitchView,
  onCompose,
  onReply,
  onQuote,
  justPosted,
}: {
  views: View[];
  activeViewId: string;
  onSwitchView: (id: string) => void;
  onCompose: () => void;
  onReply: (p: Post) => void;
  onQuote: (p: Post) => void;
  justPosted: Post | null;
}) {
  const badgeFor = useBadgeFor();
  const index = Math.max(0, views.findIndex((v) => v.id === activeViewId));
  const [dragDx, setDragDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<Record<string, number>>({});
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const gesture = useRef<Gesture | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const goTo = useCallback(
    (i: number) => {
      const v = views[Math.max(0, Math.min(i, views.length - 1))];
      if (v) onSwitchView(v.id);
    },
    [views, onSwitchView],
  );

  // View ごとの新着数 setter を安定参照でキャッシュ（ドラッグ中のページ再描画を防ぐ）
  const pendingSetters = useRef<Map<string, (n: number) => void>>(new Map());
  const pendingFor = useCallback((id: string) => {
    let fn = pendingSetters.current.get(id);
    if (!fn) {
      fn = (n: number) => setPending((prev) => (prev[id] === n ? prev : { ...prev, [id]: n }));
      pendingSetters.current.set(id, fn);
    }
    return fn;
  }, []);

  // 削除された View のキャッシュ setter を破棄する（Map の無限成長防止）
  useEffect(() => {
    const ids = new Set(views.map((v) => v.id));
    for (const key of pendingSetters.current.keys()) {
      if (!ids.has(key)) pendingSetters.current.delete(key);
    }
  }, [views]);

  // アクティブタブの下線インジケータを実測配置する
  const measureIndicator = useCallback(() => {
    const el = tabRefs.current[index];
    if (!el) return;
    // 値が不変のときは再描画を起きさせない
    setIndicator((prev) =>
      prev.left === el.offsetLeft && prev.width === el.offsetWidth
        ? prev
        : { left: el.offsetLeft, width: el.offsetWidth },
    );
  }, [index]);

  useLayoutEffect(measureIndicator, [measureIndicator, views]);
  useEffect(() => {
    window.addEventListener('resize', measureIndicator);
    return () => window.removeEventListener('resize', measureIndicator);
  }, [measureIndicator]);

  // アクティブタブを表示領域へ（§4.3。scrollIntoView 非対応環境では何もしない）
  useEffect(() => {
    tabRefs.current[index]?.scrollIntoView?.({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [index]);

  // --- ジェスチャ調停（軸ロック方式。docs/mobile-paging-spec.md §5） ---
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    gesture.current = { x0: t.clientX, y0: t.clientY, t0: performance.now(), axis: null, lastX: t.clientX };
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const g = gesture.current;
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0;
    const dy = t.clientY - g.y0;
    if (g.axis === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_SLOP) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (g.axis === 'x') setDragging(true);
    }
    if (g.axis !== 'x') return; // 縦ロック: スクロール / pull-to-refresh に委ねる
    let ddx = dx;
    if ((index === 0 && ddx > 0) || (index === views.length - 1 && ddx < 0)) ddx *= EDGE_RESISTANCE;
    g.lastX = t.clientX;
    setDragDx(ddx);
  };

  const onTouchEnd = () => {
    const g = gesture.current;
    gesture.current = null;
    setDragging(false);
    setDragDx(0);
    if (!g || g.axis !== 'x') return;
    const width = viewportRef.current?.clientWidth || window.innerWidth;
    const dx = g.lastX - g.x0;
    const dt = Math.max(1, performance.now() - g.t0);
    const byDistance = Math.abs(dx) >= width * SWIPE_DISTANCE_RATIO;
    const byFlick = Math.abs(dx) > AXIS_SLOP * 2 && Math.abs(dx) / dt >= FLICK_VELOCITY;
    if (!byDistance && !byFlick) return;
    // 端でのクランプ: 先頭で右スワイプ / 末尾で左スワイプは切替えない
    if (dx < 0 && index < views.length - 1) goTo(index + 1);
    if (dx > 0 && index > 0) goTo(index - 1);
  };

  // ページ配列をメモ化: ドラッグ中の再描画で TimelineCore サブツリーを再実行させない
  const pages = useMemo(
    () =>
      views.map((view) => (
        <section className="pager-page" key={view.id} aria-label={view.name}>
          {view.sources.length > 0 ? (
            <TimelineCore
              sources={view.sources}
              justPosted={justPosted}
              onReply={onReply}
              onQuote={onQuote}
              interactive
              badgeFor={badgeFor}
              pullToRefresh
              showOfflineBanner
              onPendingCountChange={pendingFor(view.id)}
            />
          ) : (
            <p className="empty">ソースがありません</p>
          )}
        </section>
      )),
    [views, justPosted, onReply, onQuote, badgeFor, pendingFor],
  );

  return (
    <div className="pager-root">
      <header className="pager-tabs" role="tablist" aria-label="View 切替">
        {views.map((v, i) => {
          // バッジは非アクティブタブのみ（アクティブはページ内ピルが担う。§4.4）
          const count = i === index ? 0 : (pending[v.id] ?? 0);
          return (
            <button
              key={v.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              className={`pager-tab${i === index ? ' active' : ''}`}
              role="tab"
              aria-selected={i === index}
              onClick={() => goTo(i)}
            >
              {v.name}
              {count > 0 && <span className="pager-badge">{count > 99 ? '99+' : count}</span>}
            </button>
          );
        })}
        <span
          className="pager-indicator"
          aria-hidden="true"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
      </header>

      <div
        className="pager-viewport"
        ref={viewportRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div
          className="pager-track"
          style={{
            transform: `translate3d(calc(${-index * 100}% + ${dragDx}px), 0, 0)`,
            transition: dragging ? 'none' : 'transform 320ms cubic-bezier(0.25, 0.8, 0.3, 1)',
          }}
        >
          {pages}
        </div>
      </div>

      <button className="fab" onClick={onCompose} aria-label="投稿">
        ✏️
      </button>
    </div>
  );
}
