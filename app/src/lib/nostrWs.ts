/**
 * ブラウザの WebSocket を shared/nostr の WsFactory へ適合（docs/nostr-browser-direct-spec.md §6.2、ADR-0014）。
 * `open` で resolve、`error` で reject。接続失敗は `getTimeline` が Source エラーとして表出する（§6.5）。
 */
import type { WsFactory, WsLike } from '../../../shared/nostr';

export const browserWsFactory: WsFactory = (url) =>
  new Promise<WsLike>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws as unknown as WsLike));
    ws.addEventListener('error', () => reject(new Error(`relay connect failed: ${url}`)));
  });
