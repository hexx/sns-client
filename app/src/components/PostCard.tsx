import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, TouchEvent as ReactTouchEvent } from 'react';
import type { Author, Media, Post } from '../../../shared/types';
import { ReactionPicker } from './ReactionPicker';
import { RichText } from './RichText';

/**
 * 表示名（docs/name-display-spec.md）。絵文字解決済みの displayNameRich があれば RichText inline、
 * なければプレーンテキスト。フルネームは title でホバー表示。クランプせず全文を表示する。
 */
function DisplayName({ author, className }: { author: Author; className?: string }) {
  if (author.displayNameRich && author.displayNameRich.length > 0) {
    return (
      <span className={className} title={author.displayName}>
        <RichText segments={author.displayNameRich} inline />
      </span>
    );
  }
  return (
    <span className={className} title={author.displayName}>
      {author.displayName}
    </span>
  );
}

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

/** 公開範囲バッジ（Misskey の非 public / localOnly のみ表示。アイコンのみ・説明はツールチップ。docs/card-meta-row-spec.md §4） */
function VisibilityBadge({ post }: { post: Post }) {
  const icon =
    post.visibility === 'home' ? '🏠' : post.visibility === 'followers' ? '🔒' : post.visibility === 'specified' ? '✉️' : '';
  if (!icon && !post.localOnly) return null;
  // visibility と localOnly は併存しうる（例: 🔒+📍）。ツールチップは合成する
  const tip = [post.localOnly ? 'ローカルのみ' : '', icon ? (post.visibility as string) : '']
    .filter(Boolean)
    .join('・');
  return (
    <span className="visibility" title={tip}>
      {icon}
      {post.localOnly ? '📍' : ''}
    </span>
  );
}

/** 投稿本文（rich があれば優先、なければプレーンテキスト） */
function Body({ post }: { post: Post }) {
  if (post.rich && post.rich.length > 0) return <RichText segments={post.rich} />;
  return post.text ? <p className="text">{post.text}</p> : null;
}

/** reduced-motion 設定（docs/lightbox-spec.md §9）。有効時は閉じる動作が即時になる */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type LoadStatus = 'loading' | 'done' | 'error';

/**
 * Lightbox: 投稿画像の拡大表示（docs/lightbox-spec.md）。
 * ギャラリー型 — 同一投稿内の複数 Media を ←/→ で切替。alt 常時表示。
 * 閉じる: 背景タップ / × / Esc / 画像タップ。フォーカストラップ・スクロールロック・フォーカス返却付き。
 */
function Lightbox({
  media,
  initialIndex,
  onClose,
}: {
  media: Media[];
  initialIndex: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const [status, setStatus] = useState<Record<string, LoadStatus>>({});
  const [nonce, setNonce] = useState<Record<string, number>>({});
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const startedRef = useRef(new Set<string>());
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const count = media.length;
  const current = media[index];
  const currentStatus = status[current.url] ?? 'loading';

  // アンマウント時にクローズタイマーを破棄する（App.tsx 等と同じ規約）
  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  /** フェードアウトを伴うクローズ。reduced-motion では即時（docs/lightbox-spec.md §9） */
  const requestClose = useCallback(() => {
    if (prefersReducedMotion()) {
      onClose();
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, 150);
  }, [onClose]);

  /** 画像切替。端ではクランプし循環しない（docs/lightbox-spec.md §6.2） */
  const go = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const next = i + delta;
        return next < 0 || next >= count ? i : next;
      });
    },
    [count],
  );

  // キーボード: Esc で閉じる、←/→ で切替（docs/lightbox-spec.md §8.4）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, requestClose]);

  // 開いたとき: × にフォーカス移動 + 背景スクロールロック。閉じたら復元 + 開き元へフォーカス返却（§8.2・§8.3）
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, []);

  // 現在画像と隣（±1）の先読み（docs/lightbox-spec.md §7）
  useEffect(() => {
    for (const i of [index - 1, index, index + 1]) {
      if (i < 0 || i >= count) continue;
      const url = media[i].url;
      if (startedRef.current.has(url)) continue;
      startedRef.current.add(url);
      setStatus((s) => (s[url] ? s : { ...s, [url]: 'loading' }));
      const probe = new Image();
      probe.addEventListener('load', () => setStatus((s) => ({ ...s, [url]: 'done' })), { once: true });
      probe.addEventListener('error', () => setStatus((s) => ({ ...s, [url]: 'error' })), { once: true });
      probe.src = url;
    }
  }, [index, count, media]);

  /** 再試行: nonce で img をリマウントして再読込（docs/lightbox-spec.md §7） */
  const retry = () => {
    const url = current.url;
    setNonce((n) => ({ ...n, [url]: (n[url] ?? 0) + 1 }));
    setStatus((s) => ({ ...s, [url]: 'loading' }));
  };

  // フォーカストラップ: Tab は ×・←・→ を循環（docs/lightbox-spec.md §8.2）
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !rootRef.current) return;
    const focusables = Array.from(rootRef.current.querySelectorAll<HTMLElement>('button:not(:disabled)'));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !rootRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // スワイプ: 水平 50px 以上かつ水平 > 垂直で切替（docs/lightbox-spec.md §10.6）
  const onTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  };

  return (
    <div
      ref={rootRef}
      className={`lightbox${closing ? ' lightbox-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="画像の拡大表示"
      onClick={(e) => {
        // 背景（画像・コントロール以外）クリックで閉じる。画像タップも閉じる（§5.2）
        const el = e.target as HTMLElement;
        if (el.closest('button') || el.closest('.lightbox-error')) return;
        requestClose();
      }}
      onKeyDown={trapTab}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {count > 1 && <span className="lightbox-counter">{`${index + 1} / ${count}`}</span>}
      <button ref={closeBtnRef} type="button" className="lightbox-close" aria-label="閉じる" onClick={requestClose}>
        ×
      </button>
      {count > 1 && (
        <>
          <button
            type="button"
            className="lightbox-nav lightbox-prev"
            aria-label="前の画像"
            disabled={index === 0}
            onClick={() => go(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="lightbox-nav lightbox-next"
            aria-label="次の画像"
            disabled={index === count - 1}
            onClick={() => go(1)}
          >
            ›
          </button>
        </>
      )}
      <figure className="lightbox-stage">
        <div className="lightbox-imgwrap">
          {currentStatus === 'loading' && <span className="lightbox-spinner" aria-hidden="true" />}
          {currentStatus === 'error' ? (
            <div className="lightbox-error" role="alert">
              <p>画像を読み込めませんでした</p>
              {current.alt ? <p className="lightbox-error-alt">{current.alt}</p> : null}
              <button type="button" className="lightbox-retry" onClick={retry}>
                再試行
              </button>
            </div>
          ) : (
            <img
              key={`${current.url}#${nonce[current.url] ?? 0}`}
              className={currentStatus === 'done' ? 'is-loaded' : ''}
              src={current.url}
              alt={current.alt || ''}
              onLoad={() => setStatus((s) => ({ ...s, [current.url]: 'done' }))}
              onError={() => setStatus((s) => ({ ...s, [current.url]: 'error' }))}
            />
          )}
        </div>
        {currentStatus !== 'error' && current.alt ? (
          <figcaption className="lightbox-alt">{current.alt}</figcaption>
        ) : null}
      </figure>
    </div>
  );
}

function MediaGrid({ post }: { post: Post }) {
  const media = post.media.filter((m) => m.url).slice(0, 4);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // onClose を安定化し、Lightbox 内のキーボード効果の再購読を避ける
  const handleClose = useCallback(() => setOpenIndex(null), []);
  if (media.length === 0) return null;
  return (
    <>
      <div className={`media media-${media.length}`}>
        {media.map((m, i) => (
          <button key={i} type="button" className="media-thumb" onClick={() => setOpenIndex(i)}>
            <img src={m.url} alt={m.alt || ''} loading="lazy" />
          </button>
        ))}
      </div>
      {openIndex !== null && (
        <Lightbox media={media} initialIndex={openIndex} onClose={handleClose} />
      )}
    </>
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
        <DisplayName author={post.author} className="display-name" />
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
  unread,
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
  /** 未読強調（docs/unread-divider-spec.md） */
  unread?: boolean;
}) {
  const hasReactions = !!post.reactions && post.reactions.length > 0;
  const liked = Boolean(post.viewer?.likeUri);
  const reposted = Boolean(post.viewer?.repostUri);
  return (
    <article className={`card${unread ? ' unread' : ''}`}>
      {post.repostedBy && (
        <div className="repost-badge">
          🔁 <DisplayName author={post.repostedBy} className="repost-name" /> がリポスト
        </div>
      )}

      {/* 2行ヘッダー（docs/name-display-spec.md §3）: 1行目=名前…時刻、2行目=@handle+補足チップ */}
      <div className="card-head">
        {post.author.avatarUrl ? (
          <img className="avatar" src={post.author.avatarUrl} alt="" loading="lazy" />
        ) : (
          <div className="avatar avatar-fallback" />
        )}
        <div className="author">
          <div className="author-line author-line-main">
            <DisplayName author={post.author} className="display-name" />
            <time className="time" dateTime={post.createdAt}>
              {relTime(post.createdAt)}
            </time>
          </div>
          {/* 2行目=投稿者情報（handle+公開範囲）、3行目=帰属情報（チャンネル+由来ソース）。docs/card-meta-row-spec.md §3 */}
          <div className="author-line author-line-meta">
            <span className="handle">
              @{post.author.handle}
              <VisibilityBadge post={post} />
            </span>
          </div>
          {(post.channel || badge) && (
            <div className="author-line author-line-attr">
              {post.channel && (
                <span className="channel-chip" title={post.channel.name}>
                  📺 <span className="channel-name">{post.channel.name}</span>
                </span>
              )}
              {badge && (
                <span className="provider-badge" title={badge}>
                  {badge}
                </span>
              )}
            </div>
          )}
        </div>
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
