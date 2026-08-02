import { useCallback, useEffect, useState } from 'react';
import { MobilePager } from './components/MobilePager';
import { Deck } from './components/Deck';
import { Compose } from './components/Compose';
import { ThreadView } from './components/ThreadView';
import { ProfileView } from './components/ProfileView';
import { api } from './api';
import { subscribeModerationToasts } from './lib/moderation';
import type { Author, Post, Provider, ProviderInfo, View } from '../../shared/types';

const DECK_QUERY = '(min-width: 1024px)';
/** ミュート/ブロックのトーストに取り消しを出すウィンドウ（docs/block-mute-spec.md §5.3） */
const MODERATION_TOAST_MS = 10_000;

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

/** プロフィールオーバーレイのターゲット（Provider は Author.id の解釈に必要） */
type ProfileTarget = { provider: Provider; author: Author };

/** トースト（msg + 任意の取り消しアクション + 表示時間。docs/block-mute-spec.md §5.3） */
type ToastState = { msg: string; undo?: () => void; ms: number };

export default function App() {
  const [views, setViews] = useState<View[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeViewId, setActiveViewId] = useState<string>('home');
  const [compose, setCompose] = useState<ComposeState>({ open: false });
  const [threadPost, setThreadPost] = useState<Post | null>(null);
  const [profileTarget, setProfileTarget] = useState<ProfileTarget | null>(null);
  const [justPosted, setJustPosted] = useState<Post | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  const isDeck = useIsDeckWidth();

  // ミュート/ブロックの結果トースト（取り消し付き。10秒で自動消去。docs/block-mute-spec.md §5.3）
  useEffect(
    () =>
      subscribeModerationToasts((t) => {
        setToast({ msg: t.message, undo: t.undo, ms: MODERATION_TOAST_MS });
      }),
    [],
  );

  // デッキ UI での Compose 成功トースト（deck-compose-spec §4。3秒で自動消去）
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms);
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

  /** Compose を返信/引用で開く（MobilePager と ThreadView で共有。docs/thread-view-spec.md §6.3） */
  const openReply = useCallback((p: Post) => setCompose({ open: true, replyTo: p }), []);
  const openQuote = useCallback((p: Post) => setCompose({ open: true, quote: p }), []);

  /** プロフィールオーバーレイを開く（入口はアバター・表示名・handle。docs/profile-view-spec.md §8.1） */
  const openProfile = useCallback((provider: Provider, author: Author) => {
    setProfileTarget({ provider, author });
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
            <Deck
              views={views}
              onViewsChange={handleViewsChange}
              onCompose={() => setCompose({ open: true })}
              onOpenThread={setThreadPost}
              onOpenProfile={openProfile}
            />
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
          onReply={openReply}
          onQuote={openQuote}
          onOpenThread={setThreadPost}
          onOpenProfile={openProfile}
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
            if (isDeck) setToast({ msg: '投稿しました', ms: 3000 });
          }}
        />
      )}
      {threadPost && (
        <ThreadView
          // プロフィール経由で別の投稿のスレッドを開くとき、古い focus を引きずらないよう post 単位で再マウントする
          key={`${threadPost.provider}:${threadPost.id}`}
          post={threadPost}
          justPosted={justPosted}
          onReply={openReply}
          onQuote={openQuote}
          onOpenProfile={openProfile}
          onClose={() => setThreadPost(null)}
          // プロフィールが上に被さっている間、Esc はプロフィールだけを閉じる（§8.2）
          escDisabled={profileTarget !== null}
        />
      )}
      {profileTarget && (
        <ProfileView
          provider={profileTarget.provider}
          author={profileTarget.author}
          onOpenThread={(p) => {
            // Thread はプロフィールの上に重ねず、プロフィールを閉じて開く（§8.2。オーバーレイはスタックしない）
            setProfileTarget(null);
            setThreadPost(p);
          }}
          onReply={(p) => {
            setProfileTarget(null);
            openReply(p);
          }}
          onQuote={(p) => {
            setProfileTarget(null);
            openQuote(p);
          }}
          onClose={() => setProfileTarget(null)}
        />
      )}
      {toast && (
        <div className="toast">
          {toast.msg}
          {toast.undo && (
            <button
              type="button"
              className="toast-undo"
              onClick={() => {
                // 取り消しは1回だけ（リクエスト中に連打されないようトーストを即時閉じる）
                setToast(null);
                toast.undo?.();
              }}
            >
              取り消す
            </button>
          )}
        </div>
      )}
    </>
  );
}
