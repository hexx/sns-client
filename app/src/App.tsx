import { useCallback, useEffect, useState } from 'react';
import { MobilePager } from './components/MobilePager';
import { Deck } from './components/Deck';
import { Compose } from './components/Compose';
import { api } from './api';
import type { Post, ProviderInfo, View } from '../../shared/types';

const DECK_QUERY = '(min-width: 1024px)';

/** 画面幅がデッキ UI の閾値以上か（docs/deck-view-spec.md §7） */
function useIsDeckWidth(): boolean {
  const [isDeck, setIsDeck] = useState(() => window.matchMedia(DECK_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(DECK_QUERY);
    const onChange = () => setIsDeck(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isDeck;
}

type ComposeState = { open: boolean; replyTo?: Post; quote?: Post };

export default function App() {
  const [views, setViews] = useState<View[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeViewId, setActiveViewId] = useState<string>('home');
  const [compose, setCompose] = useState<ComposeState>({ open: false });
  const [justPosted, setJustPosted] = useState<Post | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  const isDeck = useIsDeckWidth();

  // デッキ UI での Compose 成功トースト（deck-compose-spec §4。3秒で自動消去）
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.views(), api.providers()])
      .then(([v, p]) => {
        if (cancelled) return;
        setViews(v);
        setProviders(p);
        setLoadError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error('[app] failed to load views/providers', e);
        setLoadError('設定の読み込みに失敗しました');
      });
    return () => {
      cancelled = true;
    };
  }, [loadTick]);

  /** デッキ UI からの View 構成変更: 即座に反映し、BFF（KV）へ保存。失敗はバナーで通知 */
  const handleViewsChange = useCallback((next: View[]) => {
    setViews(next);
    setSaveError(null);
    api.saveViews(next).catch((e) => {
      console.error('[app] failed to save views', e);
      setSaveError('カラム構成の保存に失敗しました（表示は維持しています）');
    });
  }, []);

  const activeView = views.find((v) => v.id === activeViewId) ?? views[0];

  return (
    <>
      {loadError ? (
        <div className="banner error">
          {loadError} <button onClick={() => setLoadTick((t) => t + 1)}>再試行</button>
        </div>
      ) : isDeck ? (
        <>
          {saveError && <div className="banner error">{saveError}</div>}
          {views.length > 0 ? (
            <Deck views={views} onViewsChange={handleViewsChange} onCompose={() => setCompose({ open: true })} />
          ) : (
            <p className="empty">読み込み中…</p>
          )}
        </>
      ) : activeView ? (
        <MobilePager
          views={views}
          activeViewId={activeViewId}
          onSwitchView={setActiveViewId}
          justPosted={justPosted}
          onCompose={() => setCompose({ open: true })}
          onReply={(p) => setCompose({ open: true, replyTo: p })}
          onQuote={(p) => setCompose({ open: true, quote: p })}
        />
      ) : (
        <p className="empty">読み込み中…</p>
      )}
      {compose.open && (
        <Compose
          providers={providers}
          replyTo={compose.replyTo}
          quote={compose.quote}
          onClose={() => setCompose({ open: false })}
          onPosted={(post) => {
            setJustPosted(post);
            if (isDeck) setToast('投稿しました');
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
