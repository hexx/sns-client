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
