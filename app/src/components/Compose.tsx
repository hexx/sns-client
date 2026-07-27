import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Post, Provider, ProviderInfo } from '../../../shared/types';
import { countGraphemes } from '../lib/graphemes';

type Visibility = 'public' | 'home' | 'followers';

type Draft = {
  text: string;
  images: { file: File; previewUrl: string; alt: string }[];
  cwEnabled: boolean;
  cw: string;
  lang: string;
  visibility: Visibility;
  localOnly: boolean;
};

const EMPTY: Draft = {
  text: '',
  images: [],
  cwEnabled: false,
  cw: '',
  lang: 'ja',
  visibility: 'public',
  localOnly: false,
};
const MAX_IMAGES = 4;
const TARGET_KEY = 'compose-target';

const PROVIDER_LABEL: Record<string, string> = { bluesky: 'Bluesky', misskey: 'Misskey', mastodon: 'Mastodon', mixi2: 'mixi2' };

export function Compose({
  providers,
  replyTo,
  quote,
  onClose,
  onPosted,
}: {
  providers: ProviderInfo[];
  replyTo?: Post;
  quote?: Post;
  onClose: () => void;
  onPosted: (post: Post) => void;
}) {
  // 返信/引用中は対象プロバイダに固定（クロスプロバイダ返信は不可）
  const forced = replyTo?.provider ?? quote?.provider;
  const configured = providers.filter((p) => p.configured).map((p) => p.provider);

  const [target, setTarget] = useState<Provider>(
    () => forced ?? (localStorage.getItem(TARGET_KEY) as Provider | null) ?? 'bluesky',
  );
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // providers 読み込み後に target を有効な（configured な）プロバイダへ補正
  useEffect(() => {
    if (forced) {
      setTarget(forced);
      return;
    }
    if (configured.length === 0) return;
    if (!configured.includes(target)) {
      const saved = localStorage.getItem(TARGET_KEY) as Provider | null;
      setTarget(saved && configured.includes(saved) ? saved : configured[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, forced]);

  // アンマウント時に残りの Object URL を解放（メモリリーク防止）
  const imagesRef = useRef(draft.images);
  imagesRef.current = draft.images;
  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  // プロバイダ別の计数（bsky=grapheme / misskey=文字数）
  const cfg = providers.find((p) => p.provider === target)?.compose;
  const charLimit = cfg?.charLimit ?? 300;
  const unit = cfg?.unit ?? 'grapheme';
  const count = unit === 'grapheme' ? countGraphemes(draft.text) : draft.text.length;
  const remaining = charLimit - count;
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
      // 1) 画像を並列アップロード（プロバイダごと。misskey は alt を comment として同梱）
      const uploaded: { blob: unknown; alt: string }[] = await Promise.all(
        draft.images.map(async (img) => {
          const buf = await img.file.arrayBuffer();
          const res = await api.uploadMedia(target, buf, img.file.type || 'image/jpeg', img.alt);
          return { blob: res.blob, alt: img.alt };
        }),
      );
      // 2) 投稿（replyTo/quote は Post.ref をエコー。解釈は BFF 側）
      const post = await api.post({
        provider: target,
        text: draft.text,
        images: uploaded.length ? uploaded : undefined,
        replyTo: replyTo?.ref,
        quote: quote?.ref,
        contentWarning: draft.cwEnabled && draft.cw.trim() ? draft.cw.trim() : undefined,
        langs: target === 'bluesky' && draft.lang ? [draft.lang] : undefined,
        visibility: target === 'misskey' ? draft.visibility : undefined,
        localOnly: target === 'misskey' && draft.localOnly ? true : undefined,
      });
      localStorage.setItem(TARGET_KEY, target);
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
          {forced ? (
            <span className="target-fixed">{PROVIDER_LABEL[forced] ?? forced} に投稿</span>
          ) : (
            configured.length > 1 && (
              <select
                className="target-select"
                value={target}
                onChange={(e) => setTarget(e.target.value as Provider)}
              >
                {configured.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABEL[p] ?? p}
                  </option>
                ))}
              </select>
            )
          )}
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
          placeholder={replyTo ? '返信を投稿' : target === 'misskey' ? 'いまどうしてる？（MFM 使用可）' : 'いまどうしてる？'}
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

        {target === 'misskey' && (
          <div className="compose-visibility">
            <select
              className="lang-select"
              value={draft.visibility}
              onChange={(e) => setDraft((d) => ({ ...d, visibility: e.target.value as Visibility }))}
            >
              <option value="public">公開（public）</option>
              <option value="home">ホーム（home）</option>
              <option value="followers">フォロワー（followers）</option>
            </select>
            <label className="local-only">
              <input
                type="checkbox"
                checked={draft.localOnly}
                onChange={(e) => setDraft((d) => ({ ...d, localOnly: e.target.checked }))}
              />
              ローカルのみ
            </label>
          </div>
        )}

        {error && <div className="banner error">送信失敗（下書きは保持）: {error}</div>}

        <div className="compose-toolbar">
          <button className="tool-btn" onClick={() => fileRef.current?.click()} disabled={draft.images.length >= MAX_IMAGES}>
            🖼 {draft.images.length}/{MAX_IMAGES}
          </button>
          <button className="tool-btn" onClick={() => setDraft((d) => ({ ...d, cwEnabled: !d.cwEnabled }))}>
            {draft.cwEnabled ? 'CW✓' : 'CW'}
          </button>
          {target === 'bluesky' && (
            <select
              className="lang-select"
              value={draft.lang}
              onChange={(e) => setDraft((d) => ({ ...d, lang: e.target.value }))}
            >
              <option value="ja">日本語</option>
              <option value="en">English</option>
              <option value="">言語なし</option>
            </select>
          )}
          <span className={`counter ${counterClass}`} title={unit === 'grapheme' ? 'grapheme' : '文字'}>
            {remaining}
          </span>
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
