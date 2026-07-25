// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RichText } from '@atproto/api';
import type { AppBskyFeedDefs } from '@atproto/api';
import { buildPostRecord, mapPost } from './bsky';

function makeRt(text: string, facets?: unknown): RichText {
  const rt = new RichText({ text });
  if (facets !== undefined) rt.facets = facets as RichText['facets'];
  return rt;
}

const linkFacet = {
  index: { byteStart: 0, byteEnd: 5 },
  features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }],
};

const blob = { $type: 'blob', ref: { $link: 'cid' }, mimeType: 'image/png', size: 10 };

describe('buildPostRecord', () => {
  it('text のみ', () => {
    expect(buildPostRecord({ text: 'hello' }, makeRt('hello'))).toEqual({ text: 'hello' });
  });

  it('facets を含む', () => {
    const rec = buildPostRecord({ text: 'hello' }, makeRt('hello', [linkFacet]));
    expect(rec.facets).toEqual([linkFacet]);
  });

  it('langs を含む', () => {
    const rec = buildPostRecord({ text: 'hello', langs: ['ja'] }, makeRt('hello'));
    expect(rec.langs).toEqual(['ja']);
  });

  it('画像 → embed.images', () => {
    const rec = buildPostRecord({ text: 'hi', images: [{ blob, alt: 'alt1' }] }, makeRt('hi'));
    expect(rec.embed).toEqual({
      $type: 'app.bsky.embed.images',
      images: [{ alt: 'alt1', image: blob }],
    });
  });

  it('引用 → embed.record', () => {
    const rec = buildPostRecord({ text: 'hi', quote: { uri: 'at://q', cid: 'cq' } }, makeRt('hi'));
    expect(rec.embed).toEqual({
      $type: 'app.bsky.embed.record',
      record: { uri: 'at://q', cid: 'cq' },
    });
  });

  it('画像＋引用 → embed.recordWithMedia', () => {
    const rec = buildPostRecord(
      { text: 'hi', images: [{ blob, alt: 'a' }], quote: { uri: 'at://q', cid: 'cq' } },
      makeRt('hi'),
    );
    expect(rec.embed).toEqual({
      $type: 'app.bsky.embed.recordWithMedia',
      media: { $type: 'app.bsky.embed.images', images: [{ alt: 'a', image: blob }] },
      record: { $type: 'app.bsky.embed.record', record: { uri: 'at://q', cid: 'cq' } },
    });
  });

  it('返信 → reply.root = reply.parent', () => {
    const rec = buildPostRecord({ text: 'hi', replyTo: { uri: 'at://r', cid: 'cr' } }, makeRt('hi'));
    expect(rec.reply).toEqual({
      root: { uri: 'at://r', cid: 'cr' },
      parent: { uri: 'at://r', cid: 'cr' },
    });
  });

  it('CW → labels.selfLabels', () => {
    const rec = buildPostRecord({ text: 'hi', contentWarning: 'ネタバレ' }, makeRt('hi'));
    expect(rec.labels).toEqual({
      $type: 'com.atproto.label.defs#selfLabels',
      values: [{ val: 'ネタバレ' }],
    });
  });

  it('全部載せ（全機能の相互作用）', () => {
    const rec = buildPostRecord(
      {
        text: 'hello https://example.com',
        langs: ['ja'],
        images: [{ blob, alt: 'a' }],
        quote: { uri: 'at://q', cid: 'cq' },
        replyTo: { uri: 'at://r', cid: 'cr' },
        contentWarning: 'CW',
      },
      makeRt('hello https://example.com', [linkFacet]),
    );
    expect(rec.text).toBe('hello https://example.com');
    expect(rec.facets).toEqual([linkFacet]);
    expect(rec.langs).toEqual(['ja']);
    expect((rec.embed as { $type: string }).$type).toBe('app.bsky.embed.recordWithMedia');
    expect(rec.reply).toEqual({
      root: { uri: 'at://r', cid: 'cr' },
      parent: { uri: 'at://r', cid: 'cr' },
    });
    expect(rec.labels).toEqual({ $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'CW' }] });
  });
});

function makePostView(overrides: Record<string, unknown> = {}): AppBskyFeedDefs.PostView {
  return {
    uri: 'at://did/app.bsky.feed.post/abc',
    cid: 'cid1',
    author: {
      did: 'did:plc:x',
      handle: 'alice.bsky.social',
      displayName: 'Alice',
      avatar: 'https://a.png',
    },
    record: { text: 'hello' },
    indexedAt: '2026-07-01T12:00:00Z',
    replyCount: 1,
    repostCount: 2,
    likeCount: 3,
    ...overrides,
  } as unknown as AppBskyFeedDefs.PostView;
}

describe('mapPost', () => {
  it('PostView をドメイン Post にマッピングする', () => {
    expect(mapPost(makePostView())).toEqual({
      id: 'at://did/app.bsky.feed.post/abc',
      provider: 'bluesky',
      author: { handle: 'alice.bsky.social', displayName: 'Alice', avatarUrl: 'https://a.png' },
      text: 'hello',
      createdAt: '2026-07-01T12:00:00Z',
      media: [],
      stats: { replies: 1, reposts: 2, likes: 3 },
      source: { uri: 'at://did/app.bsky.feed.post/abc', cid: 'cid1' },
    });
  });

  it('displayName が空なら handle にフォールバック', () => {
    const post = mapPost(
      makePostView({ author: { did: 'did:x', handle: 'bob.bsky.social', displayName: '' } }),
    );
    expect(post.author.displayName).toBe('bob.bsky.social');
  });

  it('record.text が無ければ空文字', () => {
    expect(mapPost(makePostView({ record: {} })).text).toBe('');
    expect(mapPost(makePostView({ record: null })).text).toBe('');
  });

  it('stats が無ければ 0', () => {
    const post = mapPost(
      makePostView({ replyCount: undefined, repostCount: undefined, likeCount: undefined }),
    );
    expect(post.stats).toEqual({ replies: 0, reposts: 0, likes: 0 });
  });
});

describe('mapPost のメディア抽出（extractMedia）', () => {
  it('embed 無し → []', () => {
    expect(mapPost(makePostView()).media).toEqual([]);
  });

  it('images#view → fullsize‖thumb・alt‖空', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.images#view',
          images: [
            { fullsize: 'https://full.png', thumb: 'https://thumb.png', alt: 'alt1' },
            { thumb: 'https://thumb2.png' },
          ],
        },
      }),
    );
    expect(post.media).toEqual([
      { type: 'image', url: 'https://full.png', alt: 'alt1' },
      { type: 'image', url: 'https://thumb2.png', alt: '' },
    ]);
  });

  it('recordWithMedia#view → media へ再帰', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.recordWithMedia#view',
          media: {
            $type: 'app.bsky.embed.images#view',
            images: [{ fullsize: 'https://x.png', alt: 'a' }],
          },
          record: { record: { uri: 'at://q', cid: 'cq' } },
        },
      }),
    );
    expect(post.media).toEqual([{ type: 'image', url: 'https://x.png', alt: 'a' }]);
  });

  it('未知の $type → []', () => {
    const post = mapPost(
      makePostView({ embed: { $type: 'com.example.embed#view', foo: {} } }),
    );
    expect(post.media).toEqual([]);
  });
});

describe('mapPost の LinkCard 抽出（extractLinkCard）', () => {
  it('external#view → linkCard にマッピング', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.external#view',
          external: {
            uri: 'https://example.com/article',
            title: '記事タイトル',
            description: '記事の説明',
            thumb: 'https://cardyb.bsky.app/v1/extract/x',
          },
        },
      }),
    );
    expect(post.linkCard).toEqual({
      url: 'https://example.com/article',
      title: '記事タイトル',
      description: '記事の説明',
      thumbUrl: 'https://cardyb.bsky.app/v1/extract/x',
    });
  });

  it('thumb 無し → thumbUrl キーは付かない', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.external#view',
          external: { uri: 'https://example.com/', title: 't', description: 'd' },
        },
      }),
    );
    expect(post.linkCard).toEqual({ url: 'https://example.com/', title: 't', description: 'd' });
    expect(post.linkCard).not.toHaveProperty('thumbUrl');
  });

  it('title/description 欠損 → 空文字', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.external#view',
          external: { uri: 'https://example.com/' },
        },
      }),
    );
    expect(post.linkCard).toEqual({ url: 'https://example.com/', title: '', description: '' });
  });

  it('recordWithMedia#view → media の external を抽出', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.recordWithMedia#view',
          media: {
            $type: 'app.bsky.embed.external#view',
            external: { uri: 'https://example.com/q', title: 'qt', description: 'qd' },
          },
          record: { record: { uri: 'at://q', cid: 'cq' } },
        },
      }),
    );
    expect(post.linkCard).toEqual({ url: 'https://example.com/q', title: 'qt', description: 'qd' });
  });

  it('record#view（引用）→ 抽出しない（スコープ外）', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: {
            $type: 'app.bsky.embed.record#viewRecord',
            embed: {
              $type: 'app.bsky.embed.external#view',
              external: { uri: 'https://example.com/nested', title: 'n', description: '' },
            },
          },
        },
      }),
    );
    expect(post.linkCard).toBeUndefined();
  });

  it('uri 欠損 → undefined', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.external#view',
          external: { title: 't', description: 'd' },
        },
      }),
    );
    expect(post.linkCard).toBeUndefined();
  });

  it('embed 無し → undefined', () => {
    expect(mapPost(makePostView()).linkCard).toBeUndefined();
  });
});
