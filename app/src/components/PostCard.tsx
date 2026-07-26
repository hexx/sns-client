import { useState } from 'react';
import type { Post } from '../../../shared/types';
import { ReactionPicker } from './ReactionPicker';
import { RichText } from './RichText';

function relTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'たった今';
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間`;
  const d = Math.floor(h / 24);
  return `${d}日`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 公開範囲バッジ（Misskey の非 public / localOnly のみ表示） */
function VisibilityBadge({ post }: { post: Post }) {
  const icon =
    post.visibility === 'home' ? '🏠' : post.visibility === 'followers' ? '🔒' : post.visibility === 'specified' ? '✉️' : '';
  if (!icon && !post.localOnly) return null;
  return (
    <span className="visibility" title={post.localOnly ? 'ローカルのみ' : post.visibility}>
      {icon}
      {post.localOnly ? ' ローカルのみ' : ''}
    </span>
  );
}

/** 投稿本文（rich があれば優先、なければプレーンテキスト） */
function Body({ post }: { post: Post }) {
  if (post.rich && post.rich.length > 0) return <RichText segments={post.rich} />;
  return post.text ? <p className="text">{post.text}</p> : null;
}

function MediaGrid({ post }: { post: Post }) {
  const media = post.media.filter((m) => m.url).slice(0, 4);
  if (media.length === 0) return null;
  return (
    <div className={`media media-${media.length}`}>
      {media.map((m, i) => (
        <img key={i} src={m.url} alt={m.alt || ''} loading="lazy" />
      ))}
    </div>
  );
}

/** 引用カード（1階層・表示のみ） */
function QuoteCard({ post }: { post: Post }) {
  const thumb = post.media.find((m) => m.url);
  return (
    <div className="quote-card">
      <div className="quote-head">
        {post.author.avatarUrl ? (
          <img className="avatar avatar-sm" src={post.author.avatarUrl} alt="" loading="lazy" />
        ) : null}
        <span className="display-name">{post.author.displayName}</span>
        <span className="handle">@{post.author.handle}</span>
      </div>
      <Body post={post} />
      {thumb ? <img className="quote-thumb" src={thumb.url} alt={thumb.alt || ''} loading="lazy" /> : null}
    </div>
  );
}

function LinkCardView({ post }: { post: Post }) {
  const lc = post.linkCard;
  if (!lc) return null;
  return (
    <a className="link-card" href={lc.url} target="_blank" rel="noopener noreferrer">
      {lc.thumbUrl && <img className="link-card-thumb" src={lc.thumbUrl} alt="" loading="lazy" />}
      <div className="link-card-body">
        <span className="link-card-host">{hostOf(lc.url)}</span>
        <span className="link-card-title">{lc.title || hostOf(lc.url)}</span>
        {lc.description && <span className="link-card-desc">{lc.description}</span>}
      </div>
    </a>
  );
}

/** reactions チップ（表示のみ。非 Misskey / onReact 無しの場合） */
function Reactions({ post }: { post: Post }) {
  if (!post.reactions || post.reactions.length === 0) return null;
  return (
    <div className="reactions">
      {post.reactions.map((r) => (
        <span key={r.emoji} className={`reaction${r.me ? ' me' : ''}`} title={r.emoji}>
          {r.emojiUrl ? (
            <img className="reaction-emoji" src={r.emojiUrl} alt={r.emoji} />
          ) : (
            <span className="reaction-emoji-char">{r.emoji}</span>
          )}
          <span className="reaction-count">{r.count}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Misskey 用リアクションバー（操作可能。docs/misskey-reaction-action-spec.md）。
 * チップクリック＝トグル（自分の反応→解除、他→付与/置換）、「＋」でピッカー。
 */
function ReactionBar({
  post,
  onReact,
}: {
  post: Post;
  onReact: (p: Post, reaction?: string, emojiUrl?: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="reactions">
      {(post.reactions ?? []).map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={`reaction${r.me ? ' me' : ''}`}
          title={r.emoji}
          onClick={() => (r.me ? onReact(post) : onReact(post, r.emoji, r.emojiUrl))}
        >
          {r.emojiUrl ? (
            <img className="reaction-emoji" src={r.emojiUrl} alt={r.emoji} />
          ) : (
            <span className="reaction-emoji-char">{r.emoji}</span>
          )}
          <span className="reaction-count">{r.count}</span>
        </button>
      ))}
      <button
        type="button"
        className="reaction reaction-add"
        aria-label="リアクションを追加"
        onClick={() => setPickerOpen((v) => !v)}
      >
        ＋
      </button>
      {pickerOpen && (
        <ReactionPicker
          onSelect={(reaction, emojiUrl) => {
            setPickerOpen(false);
            onReact(post, reaction, emojiUrl);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

export function PostCard({
  post,
  onReply,
  onQuote,
  onReact,
  onLike,
  onRepost,
  badge,
}: {
  post: Post;
  onReply?: (p: Post) => void;
  onQuote?: (p: Post) => void;
  onReact?: (p: Post, reaction?: string, emojiUrl?: string) => void;
  /** Bluesky Like のトグル（docs/deck-view-spec.md §6） */
  onLike?: (p: Post) => void;
  /** リポスト（bsky=トグル / misskey=作成のみ） */
  onRepost?: (p: Post) => void;
  /** 帰属バッジ（プラットフォーム名 + 由来ソース名。デッキ表示用） */
  badge?: string;
}) {
  const hasReactions = !!post.reactions && post.reactions.length > 0;
  const liked = Boolean(post.viewer?.likeUri);
  const reposted = Boolean(post.viewer?.repostUri);
  return (
    <article className="card">
      {post.repostedBy && <div className="repost-badge">🔁 {post.repostedBy.displayName} がリポスト</div>}

      <div className="card-head">
        {post.author.avatarUrl ? (
          <img className="avatar" src={post.author.avatarUrl} alt="" loading="lazy" />
        ) : (
          <div className="avatar avatar-fallback" />
        )}
        <div className="author">
          <span className="display-name">{post.author.displayName}</span>
          <span className="handle">
            @{post.author.handle}
            <VisibilityBadge post={post} />
          </span>
        </div>
        <time className="time" dateTime={post.createdAt}>
          {relTime(post.createdAt)}
        </time>
        {badge && <span className="provider-badge">{badge}</span>}
        {post.channel && (
          <span className="channel-chip" title={post.channel.name}>
            📺 <span className="channel-name">{post.channel.name}</span>
          </span>
        )}
      </div>

      <Body post={post} />
      <MediaGrid post={post} />
      {post.quote && <QuoteCard post={post.quote} />}
      <LinkCardView post={post} />
      {post.provider === 'misskey' && onReact ? (
        <ReactionBar post={post} onReact={onReact} />
      ) : (
        <Reactions post={post} />
      )}

      <div className="stats">
        <span title="リプライ">💬 {post.stats.replies}</span>
        {onRepost ? (
          <button
            type="button"
            className={`stat-btn${reposted ? ' active' : ''}`}
            title={post.provider === 'misskey' ? 'リノート' : 'リポスト'}
            onClick={() => onRepost(post)}
          >
            🔁 {post.stats.reposts}
          </button>
        ) : (
          <span title="リポスト">🔁 {post.stats.reposts}</span>
        )}
        {!hasReactions &&
          (onLike && post.provider === 'bluesky' ? (
            <button
              type="button"
              className={`stat-btn${liked ? ' active' : ''}`}
              title="いいね"
              onClick={() => onLike(post)}
            >
              ❤️ {post.stats.likes}
            </button>
          ) : (
            <span title="いいね">❤️ {post.stats.likes}</span>
          ))}
        <span className="actions">
          {onReply && (
            <button className="link-btn" onClick={() => onReply(post)}>
              返信
            </button>
          )}
          {onQuote && (
            <button className="link-btn" onClick={() => onQuote(post)}>
              引用
            </button>
          )}
        </span>
      </div>
    </article>
  );
}
