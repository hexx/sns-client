import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTimeline } from './timeline';
import { api } from '../api';
import * as nostr from '../../../shared/nostr';

vi.mock('../api', () => ({ api: { timeline: vi.fn() } }));
vi.mock('../../../shared/nostr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/nostr')>();
  return { ...actual, getTimeline: vi.fn() };
});
// ブラウザ WS は開かない（ルーティングのみ検証）
vi.mock('./nostrWs', () => ({ browserWsFactory: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchTimeline ルーティング（docs/nostr-browser-direct-spec.md §6.4 / ADR-0014）', () => {
  it('nostr Source は shared getTimeline へ（/api/timeline を叩かない）', async () => {
    vi.mocked(nostr.getTimeline).mockResolvedValue({ posts: [], nextCursor: null });
    const source = { provider: 'nostr' as const, kind: 'relay', id: 'wss://yabu.me' };
    await fetchTimeline(source, 'cur');
    expect(nostr.getTimeline).toHaveBeenCalledWith(
      source,
      'cur',
      expect.objectContaining({ wsFactory: expect.any(Function) }),
    );
    expect(api.timeline).not.toHaveBeenCalled();
  });

  it('bluesky Source は BFF（api.timeline）へ', async () => {
    vi.mocked(api.timeline).mockResolvedValue({ posts: [], nextCursor: 'c' });
    const source = { provider: 'bluesky' as const, kind: 'home' };
    await fetchTimeline(source);
    expect(api.timeline).toHaveBeenCalledWith(source);
    expect(nostr.getTimeline).not.toHaveBeenCalled();
  });

  it('misskey Source は BFF（api.timeline）へ（cursor 透過）', async () => {
    vi.mocked(api.timeline).mockResolvedValue({ posts: [], nextCursor: null });
    const source = { provider: 'misskey' as const, kind: 'home' };
    await fetchTimeline(source, '123');
    expect(api.timeline).toHaveBeenCalledWith(source, '123');
    expect(nostr.getTimeline).not.toHaveBeenCalled();
  });
});
