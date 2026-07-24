const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Bluesky の文字数単位（グラフェム）で数える */
export function countGraphemes(s: string): number {
  let n = 0;
  for (const _ of seg.segment(s)) n++;
  return n;
}

export const MAX_GRAPHEMES = 300;
