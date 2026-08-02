/**
 * NotificationCard: 通知1件のカード（docs/notifications-spec.md §6/§7）。
 * - 投稿を伴う通知は対象 Post のプレビューを載せ、クリックで Thread を開く（遷移先は post.ref エコー）。
 * - postUnavailable は案内行のみ（遷移先なし。quote card の unavailable と同一イディオム）。
 * - actor のみ・テキストのみは遷移なし。
 * - メタ行に帰属バッジ（由来 Provider 名。docs/notifications-spec.md §6）。
 * - カード単位の未読強調は行わない（表示中のものは常に既読。§5）。
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Notification, Post } from '../../../shared/types';
import { PROVIDER_LABEL } from '../lib/sourceLabels';
import { NOTIF_ICON, notifText } from '../lib/notifications';
import { RichText } from './RichText';

function relTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'たった今';
  const diff = Math.max(0, Date.now() - ms); // サーバー時計誤差で未来日時でも負値にしない
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間`;
  const d = Math.floor(h / 24);
  return `${d}日`;
}

/** 対象投稿のコンパクトプレビュー（本文2行クランプ＋先頭サムネ。CW は伏せて警告のみ表示） */
function CompactPost({ post }: { post: Post }) {
  return (
    <div className="notif-post">
      <span className="notif-post-author">
        {post.author.avatarUrl && <img className="avatar-sm" src={post.author.avatarUrl} alt="" />}
        <span title={post.author.displayName}>{post.author.displayName}</span>
      </span>
      {post.cw ? (
        <span className="cw-pill">
          <span className="cw-text">{post.cw || 'CW'}</span>
        </span>
      ) : (
        <>
          {post.rich && post.rich.length > 0 ? (
            <span className="notif-post-text">
              <RichText segments={post.rich} inline />
            </span>
          ) : (
            <span className="notif-post-text">{post.text}</span>
          )}
          {post.media[0] && <img className="notif-post-thumb" src={post.media[0].url} alt="" />}
        </>
      )}
    </div>
  );
}

export function NotificationCard({
  notification,
  onOpenThread,
}: {
  notification: Notification;
  /** 投稿を伴う通知のクリックで開く Thread（docs/thread-view-spec.md） */
  onOpenThread?: (p: Post) => void;
}) {
  const n = notification;
  const icon = NOTIF_ICON[n.type] ?? '🔔';
  const clickable = Boolean(n.post);
  const open = () => {
    if (n.post) onOpenThread?.(n.post);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (clickable && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      open();
    }
  };
  return (
    <article
      className={`notif-card${clickable ? ' clickable' : ''}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={notifText(n)}
      onClick={clickable ? open : undefined}
      onKeyDown={clickable ? onKeyDown : undefined}
    >
      <span className="notif-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="notif-body">
        <div className="notif-line">
          {n.actor?.avatarUrl && <img className="avatar-sm" src={n.actor.avatarUrl} alt="" />}
          <span className="notif-text">{notifText(n)}</span>
          {/* 帰属バッジ: 由来 Provider 名のみ（通知 View 内では Source が自明。§6）。色分けなし（deck-view-spec §5） */}
          <span className="provider-badge">{PROVIDER_LABEL[n.provider]}</span>
          <time className="notif-time" dateTime={n.createdAt}>
            {relTime(n.createdAt)}
          </time>
        </div>
        {n.post && <CompactPost post={n.post} />}
        {n.postUnavailable && <div className="notif-unavailable">投稿は取得できません</div>}
      </div>
    </article>
  );
}
