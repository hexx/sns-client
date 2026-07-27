/**
 * Source カタログ由来のラベル解決（帰属バッジ用）。
 * Deck と MobilePager で共通（docs/deck-view-spec.md §5 帰属表示）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Provider, Source, SourceCatalogEntry } from '../../../shared/types';

export function sourceKey(s: Source): string {
  return `${s.provider}:${s.kind}:${s.id ?? ''}`;
}

export const PROVIDER_LABEL: Record<Provider, string> = {
  bluesky: 'Bluesky',
  misskey: 'Misskey',
  mastodon: 'Mastodon',
  mixi2: 'mixi2',
};

/**
 * 帰属バッジ生成フック: sourceKey と provider から「Misskey · 技術リスト」のような文字列を返す。
 * カタログ取得失敗時はプロバイダ名のみに縮退する。
 */
export function useBadgeFor(): (skey: string, provider: Provider) => string {
  const [labels, setLabels] = useState<SourceCatalogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .sources()
      .then((c) => {
        if (!cancelled) setLabels(c);
      })
      .catch((e) => {
        console.error('[sourceLabels] sources catalog failed', e);
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

  return useCallback(
    (skey: string, provider: Provider): string => {
      const name = labelOf.get(skey);
      const p = PROVIDER_LABEL[provider] ?? provider;
      return name ? `${p} · ${name}` : p;
    },
    [labelOf],
  );
}
