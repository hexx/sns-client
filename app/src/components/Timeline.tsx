/**
 * Timeline: モバイル（狭い画面）向けの殻。トップバー（View 切替タブ＋更新）と FAB を持ち、
 * 本体は TimelineCore に委譲する（docs/deck-view-spec.md §7 のレスポンシブ切替）。
 */
import { useRef } from 'react';
import { TimelineCore, type TimelineCoreHandle } from './TimelineCore';
import type { Post, View } from '../../../shared/types';

export function Timeline({
  view,
  views,
  onSwitchView,
  onCompose,
  onReply,
  onQuote,
  justPosted,
}: {
  view: View;
  views: View[];
  onSwitchView: (id: string) => void;
  onCompose: () => void;
  onReply: (p: Post) => void;
  onQuote: (p: Post) => void;
  justPosted: Post | null;
}) {
  const coreRef = useRef<TimelineCoreHandle>(null);

  return (
    <div className="timeline-root">
      <header className="topbar">
        <div className="view-tabs">
          {views.map((v) => (
            <button
              key={v.id}
              className={`view-tab${v.id === view.id ? ' active' : ''}`}
              onClick={() => onSwitchView(v.id)}
            >
              {v.name}
            </button>
          ))}
        </div>
        <button className="refresh-btn" onClick={() => void coreRef.current?.refresh()}>
          更新
        </button>
      </header>

      <TimelineCore
        ref={coreRef}
        sources={view.sources}
        justPosted={justPosted}
        onReply={onReply}
        onQuote={onQuote}
        pullToRefresh
        showOfflineBanner
      />

      <button className="fab" onClick={onCompose} aria-label="投稿">
        ✏️
      </button>
    </div>
  );
}
