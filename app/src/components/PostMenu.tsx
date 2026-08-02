/**
 * PostMenu: PostCard 投稿者行の ⋯ メニュー（docs/block-mute-spec.md §5.1）。
 * - 項目: 「このユーザーをミュート」「このユーザーをブロック」。対象は投稿者のみ（§6）。
 * - 自分の投稿では両項目を非表示（§5.1）。nostr（読み取り専用）ではメニュー自体を出さない（§2）。
 * - ブロックは確認ダイアログ、ミュートは即実行＋トースト（§5.2。トーストは App が描画）。
 * - メニューは画面下部では上向きに開く（overflow コンテナによるクリップ回避）。
 */
import { useEffect, useRef, useState } from 'react';
import type { Post } from '../../../shared/types';
import { blockUser, isOwnPost, muteUser } from '../lib/moderation';

export function PostMenu({ post }: { post: Post }) {
  const [open, setOpen] = useState(false);
  /** 自分の投稿か（null=判定中。判定が終わるまで項目を出さない＝自分の投稿への誤操作窓をなくす） */
  const [own, setOwn] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 自分の投稿か（/api/me の lazy キャッシュ。開くたび・投稿が変わるたびに判定し直す）
  useEffect(() => {
    setOwn(null);
    if (!open) return;
    let cancelled = false;
    void isOwnPost(post).then((v) => {
      if (!cancelled) setOwn(v);
    });
    return () => {
      cancelled = true;
    };
  }, [open, post]);

  // 外側クリック / Esc で閉じる（確認ダイアログも Esc で閉じる）
  useEffect(() => {
    if (!open && !confirming) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, confirming]);

  // nostr は読み取り専用 Provider でサーバー側ブロック/ミュートが無い（docs/block-mute-spec.md §2）
  const writable = post.provider === 'bluesky' || post.provider === 'misskey';
  if (!writable) return null;

  const showItems = open && own === false;

  const toggle = () => {
    if (!open) {
      // 画面下半分にあるカードでは上向きに開く（overflow コンテナにクリップされないように）
      const r = wrapRef.current?.getBoundingClientRect();
      setOpenUp(Boolean(r && r.bottom > window.innerHeight / 2));
    }
    setOpen((v) => !v);
  };

  return (
    <div className="card-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="card-menu-btn"
        aria-label="ユーザーメニュー"
        aria-expanded={open}
        onClick={toggle}
      >
        ⋯
      </button>
      {showItems && (
        <div className={`card-menu${openUp ? ' card-menu-up' : ''}`} role="menu">
          <button
            type="button"
            className="card-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              muteUser(post);
            }}
          >
            このユーザーをミュート
          </button>
          <button
            type="button"
            className="card-menu-item danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setConfirming(true);
            }}
          >
            このユーザーをブロック
          </button>
        </div>
      )}

      {confirming && (
        <div className="modal-backdrop" onClick={() => setConfirming(false)}>
          <div className="modal block-confirm" role="dialog" aria-modal="true" aria-label="ブロックの確認" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>ブロック</strong>
            </div>
            <p>@{post.author.handle} をブロックしますか？</p>
            <p className="block-confirm-desc">このユーザーの投稿が見えなくなり、相手からはあなたへのリプライ等ができなくなります。</p>
            <div className="compose-toolbar">
              <button
                type="button"
                className="primary-btn"
                onClick={() => {
                  setConfirming(false);
                  blockUser(post);
                }}
              >
                ブロック
              </button>
              <button type="button" className="tool-btn" onClick={() => setConfirming(false)}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
