/**
 * Source のタイムライン取得ルーティング（docs/nostr-browser-direct-spec.md §6.4、ADR-0014）。
 * nostr はブラウザ直接 WebSocket（shared/nostr）、それ以外は BFF（/api/timeline）経由。
 * `TimelineResponse` 契約は両者で同一なので、TimelineCore の時系列合成は分岐を意識しない。
 */
import { api } from '../api';
import { getTimeline } from '../../../shared/nostr';
import { browserWsFactory } from './nostrWs';
import type { Source, TimelineResponse } from '../../../shared/types';

export function fetchTimeline(source: Source, cursor?: string): Promise<TimelineResponse> {
  if (source.provider === 'nostr') {
    return getTimeline(source, cursor, { wsFactory: browserWsFactory });
  }
  // BFF 経路の呼び出し形状を旧 TimelineCore と一致させる（cursor 無しは1引数）
  return cursor === undefined ? api.timeline(source) : api.timeline(source, cursor);
}
