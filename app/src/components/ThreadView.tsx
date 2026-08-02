/**
 * ThreadView: フォーカス投稿の祖先＋子孫をオーバーレイで表示する（docs/thread-view-spec.md、ADR-0017）。
 * Lightbox / Compose と同一のオーバーレイパターン（ルーター非導入。§2）。
 * - データ: bsky/misskey は BFF、nostr はブラウザ直接解決。いずれも同じ ThreadResponse に合流する（lib/thread.ts）。
 * - 描画: ancestors → focus（強調）→ replies。インデントは depth 応、depth 5 で頭打ち（§6.2）。
 * - スレッド内の投稿クリック＝フォーカスを置換して引き直す（スタックしない。§6.2 / Q14）。
 * - 操作: reply/like/repost/reaction を TimelineCore と同じ楽観更新流儀で再利用（§6.3）。
 *   reply 成功後はスレッド再取得。nostr は読み取り専用なので操作系を表示しない（ADR-0014）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { fetchThread } from '../lib/thread';
import { isHiddenPost, subscribeHidden } from '../lib/moderation';
import { applyReaction } from '../lib/reactions';
import { withLike, withRenoteIncrement, withRepost } from '../lib/engagements';
import type { Post, ThreadResponse } from '../../../shared/types';
import { PostCard } from './PostCard';

/** インデントの最大段数（これ以上は同一の最大インデントで継続。docs/thread-view-spec.md §6.2） */
const MAX_INDENT = 5;
const INDENT_PX = 16;

function indentStyle(depth: number): { paddingLeft: number } {
  return { paddingLeft: Math.min(depth, MAX_INDENT) * INDENT_PX };
}

/** プロバイダをまたぐ id 衝突を避けるグローバル識別子（TimelineCore と同じ） */
function pid(p: Post): string {
  return `${p.provider}:${p.id}`;
}

const PROVIDER_LABEL: Record<string, string> = { bluesky: 'Bluesky', misskey: 'Misskey', nostr: 'Nostr' };

type Status = 'loading' | 'done' | 'error' | 'unavailable';

export function ThreadView({
  post,
  justPosted,
  onReply,
  onQuote,
  onClose,
}: {
  /** 初期フォーカス投稿 */
  post: Post;
  /** 投稿成功の通知（App と共有）。変化したらスレッドを再取得する（§6.3） */
  justPosted?: Post | null;
  onReply?: (p: Post) => void;
  onQuote?: (p: Post) => void;
  onClose: () => void;
}) {
  const [focus, setFocus] = useState<Post>(post);
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [nonce, setNonce] = useState(0); // 再試行・再取得のトリガ
  const [loadingMore, setLoadingMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const reactionInflight = useRef<Set<string>>(new Set());
  const engageInflight = useRef<Set<string>>(new Set());
  const lastPostedRef = useRef<Post | null | undefined>(justPosted);
  /** ブロック/ミュートの非表示セット変化の再描画トリガ（docs/block-mute-spec.md §5.4） */
  const [, setModTick] = useState(0);
  const readOnly = focus.provider === 'nostr';

  // 非表示ユーザーのノードをプレースホルダ化するため、セットの変化を購読して再描画する（§5.4）
  useEffect(() => subscribeHidden(() => setModTick((t) => t + 1)), []);

  // --- 読み込み（フォーカス置換 / 再試行で再実行） ---
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setThread(null);
    fetchThread(focus)
      .then((t) => {
        if (cancelled) return;
        setThread(t);
        setStatus('done');
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setStatus('unavailable');
        } else {
          setErrorMsg(e instanceof Error ? e.message : String(e));
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [focus, nonce]);

  // 引き直し時に先頭へ戻す（フォーカス置換 / 再試行のみ。loadMore の追記ではスクロール位置を維持する）
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [focus, nonce]);

  // Esc で閉じる（Lightbox と同一流儀。§2）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 背景スクロールロック（Lightbox と同一流儀）
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // reply 成功後の再取得（§6.3。justPosted の変化を検知。楽観挿入はせず再取得）
  useEffect(() => {
    if (justPosted && justPosted !== lastPostedRef.current && justPosted.provider === focus.provider) {
      lastPostedRef.current = justPosted;
      setNonce((n) => n + 1);
    }
    // プロバイダ不一致で再取得しなかった場合は lastPostedRef を更新しない
    // （後にフォーカスがそのプロバイダへ移ったとき、その投稿で再取得できるようにするため）
  }, [justPosted, focus.provider]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- スレッド内ローカル状態への楽観更新（TimelineCore と同じ流儀。§6.3） ---
  const patchPost = useCallback((id: string, fn: (p: Post) => Post) => {
    setThread((t) => {
      if (!t) return t;
      const map = (p: Post) => (pid(p) === id ? fn(p) : p);
      return {
        ...t,
        focus: map(t.focus),
        ancestors: t.ancestors.map(map),
        replies: t.replies.map((n) => (n.post ? { ...n, post: map(n.post) } : n)),
      };
    });
  }, []);

  const toggleReaction = useCallback(
    async (p: Post, reaction?: string, emojiUrl?: string) => {
      const id = pid(p);
      if (typeof p.ref !== 'string' || reactionInflight.current.has(id)) return;
      const original = p;
      reactionInflight.current.add(id);
      patchPost(id, (x) => applyReaction(x, reaction, emojiUrl));
      try {
        await api.react(p.ref, reaction);
      } catch {
        patchPost(id, () => original);
        setToast('リアクションに失敗しました');
      } finally {
        reactionInflight.current.delete(id);
      }
    },
    [patchPost],
  );

  const toggleLike = useCallback(
    async (p: Post) => {
      if (p.provider !== 'bluesky') return;
      const postRef = p.ref as { uri?: string; cid?: string } | undefined;
      const id = pid(p);
      if (!postRef?.uri || !postRef?.cid || engageInflight.current.has(id)) return;
      engageInflight.current.add(id);
      const original = p;
      const liked = Boolean(p.viewer?.likeUri);
      patchPost(id, (x) => withLike(x, !liked, liked ? undefined : `pending:${id}`));
      try {
        if (liked) {
          await api.unlike(p.viewer?.likeUri as string);
        } else {
          const res = await api.like(postRef.uri, postRef.cid);
          if (res.recordUri) patchPost(id, (x) => ({ ...x, viewer: { ...x.viewer, likeUri: res.recordUri } }));
        }
      } catch {
        patchPost(id, () => original);
        setToast('いいねに失敗しました');
      } finally {
        engageInflight.current.delete(id);
      }
    },
    [patchPost],
  );

  const toggleRepost = useCallback(
    async (p: Post) => {
      const id = pid(p);
      if (engageInflight.current.has(id)) return;
      engageInflight.current.add(id);
      if (p.provider === 'bluesky') {
        const postRef = p.ref as { uri?: string; cid?: string } | undefined;
        if (!postRef?.uri || !postRef?.cid) {
          engageInflight.current.delete(id);
          return;
        }
        const original = p;
        const reposted = Boolean(p.viewer?.repostUri);
        patchPost(id, (x) => withRepost(x, !reposted, reposted ? undefined : `pending:${id}`));
        try {
          if (reposted) {
            await api.unrepost(p.viewer?.repostUri as string);
          } else {
            const res = await api.repost('bluesky', postRef);
            if (res.recordUri) patchPost(id, (x) => ({ ...x, viewer: { ...x.viewer, repostUri: res.recordUri } }));
          }
        } catch {
          patchPost(id, () => original);
          setToast('リポストに失敗しました');
        } finally {
          engageInflight.current.delete(id);
        }
        return;
      }
      if (p.provider === 'misskey' && typeof p.ref === 'string') {
        try {
          await api.repost('misskey', p.ref);
          patchPost(id, withRenoteIncrement);
          setToast('リノートしました');
        } catch {
          setToast('リノートに失敗しました');
        } finally {
          engageInflight.current.delete(id);
        }
      } else {
        engageInflight.current.delete(id);
      }
    },
    [patchPost],
  );

  // --- 子孫の追加読み込み（Misskey の nextCursor のみ。§4.3） ---
  const loadMoreReplies = useCallback(async () => {
    const cursor = thread?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const more = await fetchThread(focus, cursor);
      setThread((t) => (t ? { ...t, replies: [...t.replies, ...more.replies], nextCursor: more.nextCursor } : t));
    } catch {
      setToast('追加の読み込みに失敗しました');
    } finally {
      setLoadingMore(false);
    }
  }, [thread?.nextCursor, loadingMore, focus]);

  /** スレッド内のカードへ配線するハンドラ群（nostr は閲覧専用なので操作系は undefined） */
  const handlers = readOnly
    ? {}
    : {
        onReply,
        onQuote,
        onReact: toggleReaction,
        onLike: (p: Post) => void toggleLike(p),
        onRepost: (p: Post) => void toggleRepost(p),
      };

  /** ノードの描画（ブロック/ミュート済みユーザーのノードは取得不能プレースホルダ化。§5.4。既存イディオムを再利用） */
  const renderNode = (p: Post) =>
    isHiddenPost(p) ? (
      <div className="thread-unavailable">この投稿は取得できません</div>
    ) : (
      <PostCard post={p} onOpenThread={setFocus} {...handlers} />
    );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal thread-modal"
        role="dialog"
        aria-modal="true"
        aria-label="スレッド"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="thread-title">
            スレッド
            <span className="provider-badge thread-provider">{PROVIDER_LABEL[focus.provider] ?? focus.provider}</span>
          </span>
          <button type="button" className="link-btn" onClick={onClose}>
            閉じる
          </button>
        </div>

        <div className="thread-scroll" ref={scrollRef}>
          {status === 'loading' && <p className="empty">読み込み中…</p>}
          {status === 'error' && (
            <div className="banner error">
              スレッドを読み込めませんでした{errorMsg ? `（${errorMsg}）` : ''}{' '}
              <button onClick={() => setNonce((n) => n + 1)}>再試行</button>
            </div>
          )}
          {status === 'unavailable' && <p className="empty">この投稿は取得できません</p>}

          {thread && (
            <>
              {thread.ancestors.map((p, i) => (
                <div className="thread-node" key={pid(p)} style={indentStyle(i)}>
                  {renderNode(p)}
                </div>
              ))}
              <div className="thread-node thread-node-focus">{renderNode(thread.focus)}</div>
              {thread.replies.map((n, i) =>
                n.post ? (
                  <div className="thread-node" key={`${pid(n.post)}#${i}`} style={indentStyle(n.depth)}>
                    {renderNode(n.post)}
                  </div>
                ) : (
                  <div className="thread-node" key={`unavail#${i}`} style={indentStyle(n.depth)}>
                    <div className="thread-unavailable">この投稿は取得できません</div>
                  </div>
                ),
              )}
              {thread.nextCursor && (
                <button type="button" className="link-btn thread-loadmore" onClick={() => void loadMoreReplies()}>
                  {loadingMore ? '読み込み中…' : 'さらに返信を読み込む'}
                </button>
              )}
            </>
          )}
        {toast && <div className="toast">{toast}</div>}
        </div>
      </div>
    </div>
  );
}
