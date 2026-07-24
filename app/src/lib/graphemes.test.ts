import { describe, expect, it } from 'vitest';
import { countGraphemes, MAX_GRAPHEMES } from './graphemes';

describe('countGraphemes', () => {
  it('空文字は 0', () => {
    expect(countGraphemes('')).toBe(0);
  });

  it('ASCII は文字数どおり', () => {
    expect(countGraphemes('hello')).toBe(5);
  });

  it('CJK は 1 文字ずつ', () => {
    expect(countGraphemes('日本語')).toBe(3);
  });

  it('絵文字は 1 グラフェム', () => {
    expect(countGraphemes('👍')).toBe(1);
  });

  it('ZWJ 結合の家族絵文字は 1 グラフェム', () => {
    expect(countGraphemes('👨‍👩‍👧‍👦')).toBe(1);
  });

  it('結合文字（e + 鋭音符）は 1 グラフェム', () => {
    expect(countGraphemes('e\u0301')).toBe(1);
  });

  it('混在もグラフェム単位で数える', () => {
    // "hi👍" = h, i, 👍 の 3 グラフェム
    expect(countGraphemes('hi👍')).toBe(3);
  });
});

describe('MAX_GRAPHEMES', () => {
  it('Bluesky の上限は 300', () => {
    expect(MAX_GRAPHEMES).toBe(300);
  });
});
