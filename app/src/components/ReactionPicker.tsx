/**
 * リアクション絵文字ピッカー（docs/misskey-reaction-action-spec.md）。
 * 先頭に小規模キュレーション Unicode パレット、その下に BFF 配信のローカルカスタム絵文字。
 * 検索は name/aliases の部分一致。絵文字一覧は lazy fetch＋モジュールレベルのセッションキャッシュ。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { EmojiInfo } from '../../../shared/types';

/** 小規模キュレーション Unicode パレット（「とりあえず 👍」の保険。具体的な顔ぶれは実装詳細） */
export const UNICODE_PALETTE = ['👍', '❤️', '😆', '🎉', '🤔', '👀', '🥺', '😢', '😡', '🙏', '🔥', '😇'];

/** カスタム絵文字の初期描画件数（数千件レジストリの DOM 爆発を防ぐ段階描画） */
const PAGE = 100;

let emojiListCache: EmojiInfo[] | null = null;
let emojiListInflight: Promise<EmojiInfo[]> | null = null;

/** セッションキャッシュ付きで絵文字一覧を取得する（ピッカーを開いたときだけ lazy に引く） */
export function loadEmojis(): Promise<EmojiInfo[]> {
  if (emojiListCache) return Promise.resolve(emojiListCache);
  if (!emojiListInflight) {
    emojiListInflight = api
      .emojis()
      .then((list) => {
        emojiListCache = list;
        return list;
      })
      .catch((e) => {
        emojiListInflight = null; // 失敗時は再試行できるようにする（キャッシュしない）
        throw e;
      });
  }
  return emojiListInflight;
}

/** テスト用：モジュールキャッシュをリセットする */
export function resetEmojiCache(): void {
  emojiListCache = null;
  emojiListInflight = null;
}

export function ReactionPicker({
  onSelect,
  onClose,
}: {
  onSelect: (reaction: string, emojiUrl?: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [emojis, setEmojis] = useState<EmojiInfo[] | null>(emojiListCache);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE);

  useEffect(() => {
    let cancelled = false;
    if (emojiListCache) return;
    loadEmojis()
      .then((list) => {
        if (!cancelled) setEmojis(list);
      })
      .catch(() => {
        if (!cancelled) setError('絵文字の読み込みに失敗しました');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = emojis ?? [];
    if (!q) return list;
    return list.filter(
      (e) => e.name.toLowerCase().includes(q) || (e.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
    );
  }, [emojis, q]);
  // 検索中は絞り込み結果を全件、無検索時は段階描画（DOM 节点の爆発を防ぐ）
  const shown = q ? filtered : filtered.slice(0, visible);

  return (
    <div className="picker" role="dialog" aria-label="リアクション絵文字">
      <div className="picker-head">
        <input
          className="picker-search"
          type="search"
          placeholder="絵文字を検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button className="link-btn" onClick={onClose}>
          閉じる
        </button>
      </div>
      <div className="picker-grid">
        {UNICODE_PALETTE.map((c) => (
          <button key={c} className="picker-emoji" title={c} onClick={() => onSelect(c)}>
            {c}
          </button>
        ))}
      </div>
      {error ? (
        <p className="picker-error">{error}</p>
      ) : !emojis ? (
        <p className="picker-empty">絵文字を読み込み中…</p>
      ) : (
        <div className="picker-grid picker-grid-custom">
          {shown.map((e) => (
            <button key={e.name} className="picker-emoji" title={`:${e.name}:`} onClick={() => onSelect(`:${e.name}:`, e.url)}>
              <img src={e.url} alt={`:${e.name}:`} loading="lazy" />
            </button>
          ))}
          {filtered.length === 0 && <span className="picker-empty">該当なし</span>}
          {!q && visible < filtered.length && (
            <button className="link-btn picker-more" onClick={() => setVisible((v) => v + PAGE)}>
              さらに表示（残り {filtered.length - visible}）
            </button>
          )}
        </div>
      )}
    </div>
  );
}
