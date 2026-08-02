/**
 * NotificationCard: 通知1件のカード（docs/notifications-spec.md §6/§7）。
 * - 投稿を伴う通知は対象 Post のプレビューを載せ、クリックで Thread を開く（遷移先は post.ref エコー）。
 * - postUnavailable は案内行のみ（遷移先なし。quote card の unavailable と同一イディオム）。
 * - actor のみ・テキストのみは遷移なし。
 * - メタ行に帰属バッジ（由来 Provider 名。docs/notifications-spec.md §6）。
 * - カード単位の未読強調は行わない（表示中のものは常に既読。§5）。
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Author, Notification, Post, Provider } from '../../../shared/types';
import { PROVIDER_LABEL } from '../lib/sourceLabels';
import { NOTIF_ICON, isActorlessType, notifText, notifTextBody } from '../lib/notifications';
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

/** 対象投稿のコンパクトプレビュー（本文2行クランプ＋先頭サムネ。CW は伏せて警告のみ表示）
 * asButton 時は投稿プレビュー自体が Thread への入口（actor ボタンを持つカードのキーボード操作を確保）。§8.1 */
function CompactPost({ post, asButton, onOpen }: { post: Post; asButton?: boolean; onOpen?: () => void }) {
  if (asButton) {
    // ボタン内に <a> を含めない（nested-interactive 回避）。リッチリンクはプレーンな本文で描画する
    return (
      <button
        type="button"
        className="notif-post notif-post-btn"
        aria-label={
          post.cw
            ? `投稿を開く（CW）: ${post.cw}` // CW は本文を伏せるため、隠し本文を読み上げない
            : post.text
              ? `投稿を開く: ${post.text}`
              : `${post.author.displayName} の投稿を開く`
        }
        onClick={onOpen}
      >
        {post.cw ? (
          <span className="cw-pill">
            <span className="cw-text">{post.cw || 'CW'}</span>
          </span>
        ) : (
          <>
            <span className="notif-post-text">{post.text}</span>
            {post.media[0] && <img className="notif-post-thumb" src={post.media[0].url} alt="" />}
          </>
        )}
      </button>
    );
  }
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
  onOpenProfile,
}: {
  notification: Notification;
  /** 投稿を伴う通知のクリックで開く Thread（docs/thread-view-spec.md） */
  onOpenThread?: (p: Post) => void;
  /** actor（アバター・名前）のクリックでプロフィールを開く（docs/profile-view-spec.md §8.1） */
  onOpenProfile?: (provider: Provider, a: Author) => void;
}) {
  const n = notification;
  const icon = NOTIF_ICON[n.type] ?? '🔔';
  const clickable = Boolean(n.post);
  // actor ボタンは「actor が主体」の通知だけに出す。text のみ通知（verified 等）は BFF 合成の完文が
  // 表示本体で、actor を前置きすると「◯◯ さん あなたのアカウントが認証されました」のような二重主語になる。
  // actor 無し文言の型（pollEnded 等）も同様（§8.1）
  const actorClickable = Boolean(onOpenProfile && n.actor && !n.text && !isActorlessType(n.type));
  // actor ボタンを持つカードは article を role=button にしない（button のネストは ARIA の
  // nested-interactive 違反）。その場合の Thread 遷移は投稿プレビュー（CompactPost ボタン）が担う（§8.1）
  const openThreadFromCard = clickable && !actorClickable;
  const open = () => {
    if (n.post) onOpenThread?.(n.post);
  };
  // 注意: actor ボタンを持つカードの Thread 入口は CompactPost ボタンが担う（onOpenThread 必須）。
  // onOpenProfile だけを渡して onOpenThread を渡さないと、そのカードの Thread 遷移は no-op になる。
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (openThreadFromCard && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      open();
    }
  };
  return (
    <article
      className={`notif-card${openThreadFromCard ? ' clickable' : ''}`}
      role={openThreadFromCard ? 'button' : undefined}
      tabIndex={openThreadFromCard ? 0 : undefined}
      // article 自体が操作要素のときだけラベルを付ける（actor ボタンがあるカードでは
      // ボタンのアクセシブル名と二重に読み上げられるのを防ぐ。§8.1）
      aria-label={openThreadFromCard ? notifText(n) : undefined}
      onClick={openThreadFromCard ? open : undefined}
      onKeyDown={openThreadFromCard ? onKeyDown : undefined}
    >
      <span className="notif-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="notif-body">
        <div className="notif-line">
          {actorClickable && n.actor ? (
            <button
              type="button"
              className="notif-actor-btn"
              aria-label={`${n.actor.displayName} のプロフィールを開く`}
              title="プロフィールを開く"
              onClick={() => {
                if (n.actor) onOpenProfile?.(n.provider, n.actor);
              }}
            >
              {n.actor.avatarUrl && <img className="avatar-sm" src={n.actor.avatarUrl} alt="" />}
              <span className="notif-actor-name">{n.actor.displayName}</span>
            </button>
          ) : (
            <>
              {n.actor?.avatarUrl && <img className="avatar-sm" src={n.actor.avatarUrl} alt="" />}
              <span className="notif-text">{notifText(n)}</span>
            </>
          )}
          {actorClickable && <span className="notif-text">{notifTextBody(n)}</span>}
          {/* 帰属バッジ: 由来 Provider 名のみ（通知 View 内では Source が自明。§6）。色分けなし（deck-view-spec §5） */}
          <span className="provider-badge">{PROVIDER_LABEL[n.provider]}</span>
          <time className="notif-time" dateTime={n.createdAt}>
            {relTime(n.createdAt)}
          </time>
        </div>
        {n.post && (actorClickable ? <CompactPost post={n.post} asButton onOpen={open} /> : <CompactPost post={n.post} />)}
        {n.postUnavailable && <div className="notif-unavailable">投稿は取得できません</div>}
      </div>
    </article>
  );
}
