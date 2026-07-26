import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// globals を無効にしているため、RTL の自動クリーンアップを明示登録
afterEach(() => {
  cleanup();
});

// jsdom に無い API のスタブ
// - URL.createObjectURL / revokeObjectURL: Compose の画像プレビューが使用
// - IntersectionObserver: Timeline の無限スクロールが使用
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = (): string => 'blob:mock';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = (): void => {};
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

// jsdom は matchMedia を未実装（App のデッキ切替が使用。既定 matches=false = モバイル経路）
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// jsdom は Element.scrollTo を未実装（Timeline の applyPending が使用）
// ※ node 環境（worker テスト）には Element 自体が無いためガード
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = (): void => {};
}
