import { useEffect, useState } from 'react';
import { Timeline } from './components/Timeline';
import { Compose } from './components/Compose';
import { api } from './api';
import type { Post, ProviderInfo, View } from '../../shared/types';

type ComposeState = { open: boolean; replyTo?: Post; quote?: Post };

export default function App() {
  const [views, setViews] = useState<View[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeViewId, setActiveViewId] = useState<string>('home');
  const [compose, setCompose] = useState<ComposeState>({ open: false });
  const [justPosted, setJustPosted] = useState<Post | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);

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

  const activeView = views.find((v) => v.id === activeViewId) ?? views[0];

  return (
    <>
      {loadError ? (
        <div className="banner error">
          {loadError} <button onClick={() => setLoadTick((t) => t + 1)}>再試行</button>
        </div>
      ) : activeView ? (
        <Timeline
          view={activeView}
          views={views}
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
          onPosted={(post) => setJustPosted(post)}
        />
      )}
    </>
  );
}
