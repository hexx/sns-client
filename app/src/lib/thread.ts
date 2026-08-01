/**
 * スレッド取得のルーティング（docs/thread-view-spec.md §4/§5、ADR-0014/0017）。
 * nostr はブラウザ直接 WebSocket（shared/nostr）で解決し、それ以外は BFF（/api/thread）経由。
 * `ThreadResponse` 契約は両者で同一なので、ThreadView の描画は分岐を意識しない。
 */
import { api } from '../api';
import { getThread } from '../../../shared/nostr';
import { browserWsFactory } from './nostrWs';
import type { Post, ThreadResponse } from '../../../shared/types';

export function fetchThread(post: Post, cursor?: string): Promise<ThreadResponse> {
  if (post.provider === 'nostr') return getThread(post, { wsFactory: browserWsFactory });
  return api.thread(post.provider, post.ref, cursor);
}
