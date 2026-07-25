import type { Post } from '../../../shared/types';

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

export function PostCard({
  post,
  onReply,
  onQuote,
}: {
  post: Post;
  onReply?: (p: Post) => void;
  onQuote?: (p: Post) => void;
}) {
  // 空 URL（投稿直後のフォールバック等）は除外し、最大4枚に揃える
  const media = post.media.filter((m) => m.url).slice(0, 4);
  return (
    <article className="card">
      <div className="card-head">
        {post.author.avatarUrl ? (
          <img className="avatar" src={post.author.avatarUrl} alt="" loading="lazy" />
        ) : (
          <div className="avatar avatar-fallback" />
        )}
        <div className="author">
          <span className="display-name">{post.author.displayName}</span>
          <span className="handle">@{post.author.handle}</span>
        </div>
        <time className="time" dateTime={post.createdAt}>
          {relTime(post.createdAt)}
        </time>
      </div>

      {post.text && <p className="text">{post.text}</p>}

      {media.length > 0 && (
        <div className={`media media-${media.length}`}>
          {media.map((m, i) => (
            <img key={i} src={m.url} alt={m.alt || ''} loading="lazy" />
          ))}
        </div>
      )}

      {post.linkCard && (
        <a
          className="link-card"
          href={post.linkCard.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {post.linkCard.thumbUrl && (
            <img className="link-card-thumb" src={post.linkCard.thumbUrl} alt="" loading="lazy" />
          )}
          <div className="link-card-body">
            <span className="link-card-host">{hostOf(post.linkCard.url)}</span>
            <span className="link-card-title">
              {post.linkCard.title || hostOf(post.linkCard.url)}
            </span>
            {post.linkCard.description && (
              <span className="link-card-desc">{post.linkCard.description}</span>
            )}
          </div>
        </a>
      )}

      <div className="stats">
        <span title="リプライ">💬 {post.stats.replies}</span>
        <span title="リポスト">🔁 {post.stats.reposts}</span>
        <span title="いいね">❤️ {post.stats.likes}</span>
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
