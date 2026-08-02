/**
 * プロフィール取得のルーティング（docs/profile-view-spec.md §4/§5/§7、ADR-0014）。
 * nostr はブラウザ直接 WebSocket（shared/nostr）で解決し、それ以外は BFF（/api/profile）経由。
 * `Profile` / `TimelineResponse` 契約は両者で同一なので、ProfileView の描画は分岐を意識しない。
 */
import { api } from '../api';
import { getProfile as getNostrProfile, getProfilePosts as getNostrProfilePosts } from '../../../shared/nostr';
import { browserWsFactory } from './nostrWs';
import type { Author, Profile, Provider, TimelineResponse } from '../../../shared/types';

export function fetchProfile(provider: Provider, author: Author): Promise<Profile> {
  if (provider === 'nostr') return getNostrProfile(author.id, { wsFactory: browserWsFactory });
  // mastodon・mixi2 は型上予約のみ（未実装）
  if (provider !== 'bluesky' && provider !== 'misskey') return Promise.reject(new Error(`unsupported provider: ${provider}`));
  return api.profile(provider, author.id);
}

export function fetchProfilePosts(provider: Provider, author: Author, cursor?: string): Promise<TimelineResponse> {
  if (provider === 'nostr') return getNostrProfilePosts(author.id, { wsFactory: browserWsFactory });
  if (provider !== 'bluesky' && provider !== 'misskey') return Promise.reject(new Error(`unsupported provider: ${provider}`));
  return api.profilePosts(provider, author.id, cursor);
}
