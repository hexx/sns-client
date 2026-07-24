import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Post } from '../../../shared/types';
import { countGraphemes, MAX_GRAPHEMES } from '../lib/graphemes';

type Draft = {
  text: string;
  images: { file: File; previewUrl: string; alt: string }[];
  cwEnabled: boolean;
  cw: string;
  lang: string;
};

const EMPTY: Draft = { text: '', images: [], cwEnabled: false, cw: '', lang: 'ja' };
const MAX_IMAGES = 4;

function refOf(post: Post): { uri: string; cid: string } {
  const s = post.source as { uri: string; cid: string };
  return { uri: s.uri, cid: s.cid };
}

export function Compose({
  replyTo,
  quote,
  onClose,
  onPosted,
}: {
  replyTo?: Post;
  quote?: Post;
  onClose: () => void;
  onPosted: (post: Post) => void;
}) {
  // 失敗しても下書きを消さない（初期値を保持）
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // アンマウント時に残りの Object URL を解放（メモリリーク防止）
  const imagesRef = useRef(draft.images);
  imagesRef.current = draft.images;
  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  const count = countGraphemes(draft.text);
  const remaining = MAX_GRAPHEMES - count;
  const over = remaining < 0;
  const empty = draft.text.trim().length === 0 && draft.images.length === 0;
  let counterClass = '';
  if (over) counterClass = 'over';
  else if (remaining <= 20) counterClass = 'warn';

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    setDraft((d) => {
      const imgs = [...d.images];
      for (const f of Array.from(files)) {
        if (imgs.length >= MAX_IMAGES) break;
        if (!f.type.startsWith('image/')) continue;
        imgs.push({ file: f, previewUrl: URL.createObjectURL(f), alt: '' });
      }
      return { ...d, images: imgs };
    });
  };

  const submit = async () => {
    if (over || empty || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // 1) 画像を順にアップロード
      const uploaded: { blob: unknown; alt: string }[] = [];
      for (const img of draft.images) {
        const buf = await img.file.arrayBuffer();
        const res = await api.uploadMedia(buf, img.file.type || 'image/jpeg');
        uploaded.push({ blob: res.blob, alt: img.alt });
      }
      // 2) 投稿
      const post = await api.post({
        text: draft.text,
        images: uploaded.length ? uploaded : undefined,
        replyTo: replyTo ? refOf(replyTo) : undefined,
        quote: quote ? refOf(quote) : undefined,
        contentWarning: draft.cwEnabled && draft.cw.trim() ? draft.cw.trim() : undefined,
        langs: draft.lang ? [draft.lang] : undefined,
      });
      onPosted(post);
      setDraft(EMPTY);
      onClose();
    } catch (e) {
      console.error('[post]', e);
      setError('送信に失敗しました。時間をおいてもう一度お試しください。'); // 下書きは保持
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <button className="link-btn" onClick={onClose}>
            閉じる
          </button>
          <button className="primary-btn" disabled={over || empty || submitting} onClick={() => void submit()}>
            {submitting ? '送信中…' : '投稿'}
          </button>
        </div>

        {replyTo && (
          <div className="ctx-banner">
            返信先: @{replyTo.author.handle}
            <span className="ctx-text">{replyTo.text.slice(0, 60)}</span>
          </div>
        )}
        {quote && (
          <div className="ctx-banner">
            引用: @{quote.author.handle}
            <span className="ctx-text">{quote.text.slice(0, 60)}</span>
          </div>
        )}

        <textarea
          className="compose-text"
          placeholder={replyTo ? '返信を投稿' : 'いまどうしてる？'}
          value={draft.text}
          autoFocus
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
        />

        {draft.images.length > 0 && (
          <div className="compose-images">
            {draft.images.map((img, i) => (
              <div className="compose-image" key={i}>
                <img src={img.previewUrl} alt="" />
                <input
                  className="alt-input"
                  placeholder="alt（説明）"
                  value={img.alt}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      images: d.images.map((x, j) => (j === i ? { ...x, alt: e.target.value } : x)),
                    }))
                  }
                />
                <button
                  className="remove-img"
                  onClick={() =>
                    setDraft((d) => {
                      URL.revokeObjectURL(d.images[i].previewUrl);
                      return { ...d, images: d.images.filter((_, j) => j !== i) };
                    })
                  }
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {draft.cwEnabled && (
          <input
            className="cw-input"
            placeholder="コンテンツ警告（例: ネタバレ）"
            value={draft.cw}
            onChange={(e) => setDraft((d) => ({ ...d, cw: e.target.value }))}
          />
        )}

        {error && <div className="banner error">送信失敗（下書きは保持）: {error}</div>}

        <div className="compose-toolbar">
          <button className="tool-btn" onClick={() => fileRef.current?.click()} disabled={draft.images.length >= MAX_IMAGES}>
            🖼 {draft.images.length}/{MAX_IMAGES}
          </button>
          <button className="tool-btn" onClick={() => setDraft((d) => ({ ...d, cwEnabled: !d.cwEnabled }))}>
            {draft.cwEnabled ? 'CW✓' : 'CW'}
          </button>
          <select
            className="lang-select"
            value={draft.lang}
            onChange={(e) => setDraft((d) => ({ ...d, lang: e.target.value }))}
          >
            <option value="ja">日本語</option>
            <option value="en">English</option>
            <option value="">言語なし</option>
          </select>
          <span className={`counter ${counterClass}`}>{remaining}</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </div>
    </div>
  );
}
