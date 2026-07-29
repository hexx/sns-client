import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Destination, DestinationOption, Post, ProviderInfo } from '../../../shared/types';
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
const DEST_KEY = 'compose-destination';

const PROVIDER_LABEL: Record<string, string> = { bluesky: 'Bluesky', misskey: 'Misskey', mastodon: 'Mastodon', mixi2: 'mixi2' };

/** Destination をセレクトの value として一意に識別するキー */
function destKey(d: Destination): string {
  return `${d.provider}:${d.kind}:${d.id ?? ''}`;
}

/** reply/quote 先から強制 Destination を導出する（チャンネルノートならそのチャンネル、さもなくば home。docs/compose-destination-spec.md §5.4） */
function forcedDestOf(post?: Post): Destination | undefined {
  if (!post) return undefined;
  if (post.channel) return { provider: 'misskey', kind: 'channel', id: post.channel.id };
  return { provider: post.provider, kind: 'home' };
}

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
  // 返信/引用中は対象 Destination に固定（クロスプロバイダ・クロスチャンネル返信は不可）
  const ctxPost = replyTo ?? quote;
  // 毎レンダーの新オブジェクト生成を避け、effect の依存を安定化（無限ループ防止）
  const forced = useMemo(() => forcedDestOf(ctxPost), [replyTo, quote]);
  // compose を持たない読み取り専用 Provider（nostr）は投稿先から除外（docs/nostr-integration-spec.md §5.3）
  const configured = providers.filter((p) => p.configured && p.compose).map((p) => p.provider);

  const [destination, setDestination] = useState<Destination>(
    () =>
      forced ??
      (() => {
        try {
          const saved = localStorage.getItem(DEST_KEY);
          if (saved) {
            const d = JSON.parse(saved) as Destination;
            if (d && (d.kind === 'home' || d.kind === 'channel')) return d;
          }
        } catch {
          /* 壊れた保存値は無視して既定へ */
        }
        return { provider: 'bluesky', kind: 'home' };
      })(),
  );
  const [catalog, setCatalog] = useState<DestinationOption[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 投稿先カタログの取得（失敗時は home のみの静的フォールバックで動作継続。docs/compose-destination-spec.md §5.1）
  useEffect(() => {
    let alive = true;
    api
      .destinations()
      .then((entries) => {
        if (alive) setCatalog(entries.flatMap((e) => e.options));
      })
      .catch((e) => {
        console.error('[compose] destination catalog failed', e);
        /* catalog=null のまま → home 静的フォールバック */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 選択可能オプション（カタログ + configured プロバイダの home 静的フォールバック、重複排除）
  const options = useMemo(() => {
    const list: DestinationOption[] = [];
    const seen = new Set<string>();
    const push = (o: DestinationOption) => {
      const k = destKey(o.destination);
      if (seen.has(k)) return;
      seen.add(k);
      list.push(o);
    };
    for (const o of catalog ?? []) push(o);
    for (const p of configured) push({ destination: { provider: p, kind: 'home' }, name: 'ホーム' });
    // 読込中の現在選択（チャンネル）が候補に無くても select の value が欠落しないようにする
    if (destination.kind === 'channel') push({ destination, name: `📺 ${destination.id}` });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, providers, destination]);

  // providers/カタログ読み込み後に destination を有効値へ補正
  useEffect(() => {
    if (forced) {
      setDestination(forced);
      return;
    }
    if (configured.length === 0) return;
    if (!configured.includes(destination.provider)) {
      setDestination({ provider: configured[0], kind: 'home' });
      return;
    }
    // カタログ読込後、存在しないチャンネルを指した保存値は当該プロバイダの home へフォールバック
    if (catalog && destination.kind === 'channel' && !options.some((o) => destKey(o.destination) === destKey(destination))) {
      setDestination({ provider: destination.provider, kind: 'home' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, catalog, forced]);

  // アンマウント時に残りの Object URL を解放（メモリリーク防止）
  const imagesRef = useRef(draft.images);
  imagesRef.current = draft.images;
  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  const target = destination.provider;
  const isChannel = destination.kind === 'channel';

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
      // チャンネル投稿は visibility/localOnly を送らない（Misskey サーバが public/localOnly=true に強制するため。docs/compose-destination-spec.md §5.3）
      const post = await api.post({
        provider: target,
        destination,
        text: draft.text,
        images: uploaded.length ? uploaded : undefined,
        replyTo: replyTo?.ref,
        quote: quote?.ref,
        contentWarning: draft.cwEnabled && draft.cw.trim() ? draft.cw.trim() : undefined,
        langs: target === 'bluesky' && draft.lang ? [draft.lang] : undefined,
        visibility: target === 'misskey' && !isChannel ? draft.visibility : undefined,
        localOnly: target === 'misskey' && !isChannel && draft.localOnly ? true : undefined,
      });
      localStorage.setItem(DEST_KEY, JSON.stringify(destination));
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
            <span className="target-fixed">
              {forced.kind === 'channel'
                ? `📺 ${ctxPost?.channel?.name ?? forced.id ?? ''} へ投稿`
                : `${PROVIDER_LABEL[forced.provider] ?? forced.provider} に投稿`}
            </span>
          ) : (
            options.length > 1 && (
              <select
                className="target-select"
                aria-label="投稿先"
                value={destKey(destination)}
                onChange={(e) => {
                  const next = options.find((o) => destKey(o.destination) === e.target.value);
                  if (next) setDestination(next.destination);
                }}
              >
                {configured.map((p) => {
                  const opts = options.filter((o) => o.destination.provider === p);
                  if (opts.length === 0) return null;
                  return (
                    <optgroup key={p} label={PROVIDER_LABEL[p] ?? p}>
                      {opts.map((o) => (
                        <option key={destKey(o.destination)} value={destKey(o.destination)}>
                          {o.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
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

        {target === 'misskey' && !isChannel && (
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

        {target === 'misskey' && isChannel && (
          <div className="compose-visibility-note">チャンネル投稿は公開・ローカルのみ（Misskey 仕様）</div>
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
