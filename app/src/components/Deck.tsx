/**
 * Deck: デスクトップ向けの TweetDeck 風 UI（docs/deck-view-spec.md §7）。
 * View ごとに固定幅カラムを横並びにし、カラムの追加・編集・削除・並び替えを UI から行って
 * BFF（KV）に保存する。各カラムのタイムライン本体は TimelineCore を再利用。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { TimelineCore } from './TimelineCore';
import type { Provider, Source, SourceCatalogEntry, SourceOption, View } from '../../../shared/types';

function sourceKey(s: Source): string {
  return `${s.provider}:${s.kind}:${s.id ?? ''}`;
}

const KIND_LABEL: Record<string, string> = { home: 'ホーム', list: 'リスト', antenna: 'アンテナ', feed: 'フィード' };
const PROVIDER_LABEL: Record<string, string> = { bluesky: 'Bluesky', misskey: 'Misskey', mastodon: 'Mastodon' };

/** カラム編集ダイアログ: 名前と Source 構成を選んで保存する */
function ColumnEditor({
  initial,
  catalog,
  catalogError,
  onSave,
  onClose,
}: {
  initial: View;
  catalog: SourceCatalogEntry[];
  catalogError: string | null;
  onSave: (view: View) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial.sources.map(sourceKey)));
  const [sourceOf, setSourceOf] = useState<Map<string, Source>>(() => new Map(initial.sources.map((s) => [sourceKey(s), s])));

  const toggle = (opt: SourceOption) => {
    const k = sourceKey(opt.source);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
    setSourceOf((prev) => new Map(prev).set(k, opt.source));
  };

  const save = () => {
    // 表示順（カタログ順）で確定。選択のみで元の名前を復元しない（名前はユーザー入力優先）
    const sources: Source[] = [];
    for (const entry of catalog) {
      for (const opt of entry.options) {
        const k = sourceKey(opt.source);
        if (selected.has(k)) sources.push(sourceOf.get(k) ?? opt.source);
      }
    }
    // カタログ未取得で初期選択だけあるケース（既存ソースを維持）
    for (const s of initial.sources) {
      const k = sourceKey(s);
      if (selected.has(k) && !sources.some((x) => sourceKey(x) === k)) sources.push(s);
    }
    onSave({ ...initial, name: name.trim() || '無題', sources });
  };

  const valid = name.trim().length > 0 && selected.size > 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>カラムを編集</strong>
          <button className="link-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <input
          className="cw-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="カラム名"
          aria-label="カラム名"
        />
        {catalogError && <div className="banner error">{catalogError}</div>}
        <div className="source-picker">
          {catalog.map((entry) => (
            <fieldset key={entry.provider} className="source-group">
              <legend>{PROVIDER_LABEL[entry.provider] ?? entry.provider}</legend>
              {entry.error && <p className="picker-error">取得に失敗しました</p>}
              {entry.options.map((opt) => {
                const k = sourceKey(opt.source);
                return (
                  <label key={k} className="source-opt">
                    <input type="checkbox" checked={selected.has(k)} onChange={() => toggle(opt)} />
                    <span className="source-kind">{KIND_LABEL[opt.source.kind] ?? opt.source.kind}</span>
                    <span className="source-name">{opt.name}</span>
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
        <div className="compose-toolbar">
          <button className="primary-btn" disabled={!valid} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export function Deck({
  views,
  onViewsChange,
  onCompose,
}: {
  views: View[];
  /** View 構成の変更（App が状態反映＋BFF 保存を担う） */
  onViewsChange: (views: View[]) => void;
  /** Compose（新規投稿）モーダルを開く（deck-compose-spec §4） */
  onCompose: () => void;
}) {
  const [editing, setEditing] = useState<{ view: View; isNew: boolean } | null>(null);
  const [catalog, setCatalog] = useState<SourceCatalogEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [labels, setLabels] = useState<SourceCatalogEntry[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState<View | null>(null);

  // 帰属バッジ用のソース名カタログ（マウント時に1度。失敗時はバッジをプロバイダ名のみに縮退）
  useEffect(() => {
    let cancelled = false;
    api
      .sources()
      .then((c) => {
        if (!cancelled) setLabels(c);
      })
      .catch((e) => {
        console.error('[deck] sources catalog failed', e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const labelOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const entry of labels) for (const opt of entry.options) m.set(sourceKey(opt.source), opt.name);
    return m;
  }, [labels]);

  const badgeFor = useCallback(
    (skey: string, provider: Provider): string => {
      const name = labelOf.get(skey);
      const p = PROVIDER_LABEL[provider] ?? provider;
      return name ? `${p} · ${name}` : p;
    },
    [labelOf],
  );

  // ピッカーカタログは編集ダイアログを開いたときに取得（キャッシュしない。リスト変更を反映するため）
  const editorOpen = editing !== null;
  useEffect(() => {
    if (!editorOpen) return;
    let cancelled = false;
    setCatalogError(null);
    api
      .sources()
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch((e) => {
        if (!cancelled) setCatalogError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [editorOpen]); // ダイアログ開閉時のみ再取得

  const move = useCallback(
    (id: string, dir: -1 | 1) => {
      const i = views.findIndex((v) => v.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= views.length) return;
      const next = [...views];
      [next[i], next[j]] = [next[j], next[i]];
      onViewsChange(next);
    },
    [views, onViewsChange],
  );

  const remove = useCallback(
    (view: View) => {
      onViewsChange(views.filter((v) => v.id !== view.id));
      setConfirmingDelete(null);
    },
    [views, onViewsChange],
  );

  const saveEditing = (view: View) => {
    if (!editing) return;
    const exists = views.some((v) => v.id === view.id);
    onViewsChange(exists ? views.map((v) => (v.id === view.id ? view : v)) : [...views, view]);
    setEditing(null);
  };

  return (
    <div className="deck">
      {views.map((view, i) => (
        <section className="deck-col" key={view.id} aria-label={view.name}>
          <header className="deck-col-head">
            <span className="deck-col-title" title={view.name}>
              {view.name}
            </span>
            <button onClick={() => move(view.id, -1)} disabled={i === 0} aria-label="左へ移動" title="左へ移動">
              ◀
            </button>
            <button onClick={() => move(view.id, 1)} disabled={i === views.length - 1} aria-label="右へ移動" title="右へ移動">
              ▶
            </button>
            <button onClick={() => setEditing({ view, isNew: false })} aria-label="編集" title="編集">
              ⚙
            </button>
            <button onClick={() => setConfirmingDelete(view)} aria-label="削除" title="削除">
              ✕
            </button>
          </header>
          {view.sources.length > 0 ? (
            <TimelineCore sources={view.sources} interactive badgeFor={badgeFor} />
          ) : (
            <p className="empty">ソースがありません（⚙ から追加）</p>
          )}
        </section>
      ))}

      <button
        className="deck-add"
        onClick={() =>
          setEditing({
            view: { id: crypto.randomUUID(), name: '新しいカラム', sources: [] },
            isNew: true,
          })
        }
      >
        + カラム追加
      </button>

      <button className="deck-compose-fab" onClick={onCompose} aria-label="新規投稿" title="新規投稿">
        ✏ 新規投稿
      </button>

      {editing && (
        <ColumnEditor
          key={editing.view.id}
          initial={editing.view}
          catalog={catalog}
          catalogError={catalogError}
          onSave={saveEditing}
          onClose={() => setEditing(null)}
        />
      )}

      {confirmingDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmingDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>カラムを削除</strong>
            </div>
            <p>
              「{confirmingDelete.name}」を削除しますか？
            </p>
            <div className="compose-toolbar">
              <button className="primary-btn" onClick={() => remove(confirmingDelete)}>
                削除
              </button>
              <button className="tool-btn" onClick={() => setConfirmingDelete(null)}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
