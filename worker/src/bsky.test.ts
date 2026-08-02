// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RichText } from '@atproto/api';
import type { AppBskyFeedDefs, AppBskyRichtextFacet } from '@atproto/api';
import { buildPostRecord, facetsToRich, mapPost, threadViewToResponse } from './bsky';

type Facets = AppBskyRichtextFacet.Main[];
const enc = new TextEncoder();
const blen = (s: string) => enc.encode(s).length;
function facet(byteStart: number, byteEnd: number, ...features: Record<string, unknown>[]): Facets[number] {
  return { index: { byteStart, byteEnd }, features } as unknown as Facets[number];
}

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
    expect(buildPostRecord({ provider: 'bluesky', text: 'hello' }, makeRt('hello'))).toEqual({ text: 'hello' });
  });

  it('facets を含む', () => {
    const rec = buildPostRecord({ provider: 'bluesky', text: 'hello' }, makeRt('hello', [linkFacet]));
    expect(rec.facets).toEqual([linkFacet]);
  });

  it('langs を含む', () => {
    const rec = buildPostRecord({ provider: 'bluesky', text: 'hello', langs: ['ja'] }, makeRt('hello'));
    expect(rec.langs).toEqual(['ja']);
  });

  it('画像 → embed.images', () => {
    const rec = buildPostRecord({ provider: 'bluesky', text: 'hi', images: [{ blob, alt: 'alt1' }] }, makeRt('hi'));
    expect(rec.embed).toEqual({
      $type: 'app.bsky.embed.images',
      images: [{ alt: 'alt1', image: blob }],
    });
  });

  it('引用 → embed.record', () => {
    const rec = buildPostRecord({ provider: 'bluesky', text: 'hi', quote: { uri: 'at://q', cid: 'cq' } }, makeRt('hi'));
    expect(rec.embed).toEqual({
      $type: 'app.bsky.embed.record',
      record: { uri: 'at://q', cid: 'cq' },
    });
  });

  it('画像＋引用 → embed.recordWithMedia', () => {
    const rec = buildPostRecord(
      { provider: 'bluesky', text: 'hi', images: [{ blob, alt: 'a' }], quote: { uri: 'at://q', cid: 'cq' } },
      makeRt('hi'),
    );
    expect(rec.embed).toEqual({
      $type: 'app.bsky.embed.recordWithMedia',
      media: { $type: 'app.bsky.embed.images', images: [{ alt: 'a', image: blob }] },
      record: { $type: 'app.bsky.embed.record', record: { uri: 'at://q', cid: 'cq' } },
    });
  });

  it('返信 → reply.root = reply.parent', () => {
    const rec = buildPostRecord({ provider: 'bluesky', text: 'hi', replyTo: { uri: 'at://r', cid: 'cr' } }, makeRt('hi'));
    expect(rec.reply).toEqual({
      root: { uri: 'at://r', cid: 'cr' },
      parent: { uri: 'at://r', cid: 'cr' },
    });
  });

  it('CW → labels.selfLabels', () => {
    const rec = buildPostRecord({ provider: 'bluesky', text: 'hi', contentWarning: 'ネタバレ' }, makeRt('hi'));
    expect(rec.labels).toEqual({
      $type: 'com.atproto.label.defs#selfLabels',
      values: [{ val: 'ネタバレ' }],
    });
  });

  it('全部載せ（全機能の相互作用）', () => {
    const rec = buildPostRecord(
      {
        provider: 'bluesky',
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
      author: { id: 'did:plc:x', handle: 'alice.bsky.social', displayName: 'Alice', avatarUrl: 'https://a.png' },
      text: 'hello',
      createdAt: '2026-07-01T12:00:00Z',
      media: [],
      stats: { replies: 1, reposts: 2, likes: 3 },
      ref: { uri: 'at://did/app.bsky.feed.post/abc', cid: 'cid1' },
      source: { uri: 'at://did/app.bsky.feed.post/abc', cid: 'cid1' },
      url: 'https://bsky.app/profile/did/post/abc',
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

  it('record.facets から rich を生成する', () => {
    const url = 'https://example.com';
    const post = mapPost(
      makePostView({
        record: { text: url, facets: [facet(0, blen(url), { $type: 'app.bsky.richtext.facet#link', uri: url })] },
      }),
    );
    expect(post.rich).toEqual([{ type: 'link', url, text: url }]);
  });

  it('facets 無しなら rich は無い', () => {
    expect(mapPost(makePostView()).rich).toBeUndefined();
  });
});

describe('facetsToRich（docs/bsky-facets-spec.md）', () => {
  it('link を変換する', () => {
    const url = 'https://example.com';
    const rich = facetsToRich(`see ${url} now`, [
      facet(4, 4 + blen(url), { $type: 'app.bsky.richtext.facet#link', uri: url }),
    ]);
    expect(rich).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', url, text: url },
      { type: 'text', text: ' now' },
    ]);
  });

  it('マルチバイト（絵文字・日本語）境界をバイトオフセットで正しく扱う', () => {
    const pre = '🎉日本語 ';
    const url = 'https://example.com';
    const rich = facetsToRich(`${pre}${url}`, [
      facet(blen(pre), blen(pre) + blen(url), { $type: 'app.bsky.richtext.facet#link', uri: url }),
    ]);
    expect(rich).toEqual([
      { type: 'text', text: pre },
      { type: 'link', url, text: url },
    ]);
  });

  it('mention は表示テキスト由来 handle と bsky.app URL', () => {
    const m = '@alice.bsky.social';
    const rich = facetsToRich(`${m} hi`, [
      facet(0, blen(m), { $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:abc' }),
    ]);
    expect(rich).toEqual([
      { type: 'mention', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/did:plc:abc' },
      { type: 'text', text: ' hi' },
    ]);
  });

  it('tag を hashtag に変換する', () => {
    const rich = facetsToRich('#hello world', [
      facet(0, 6, { $type: 'app.bsky.richtext.facet#tag', tag: 'hello' }),
    ]);
    expect(rich).toEqual([
      { type: 'hashtag', tag: 'hello' },
      { type: 'text', text: ' world' },
    ]);
  });

  it('未ソート入力は byteStart 昇順で処理する', () => {
    const url = 'https://example.com';
    const text = `a ${url} #t`;
    const tagStart = blen(`a ${url} `);
    const rich = facetsToRich(text, [
      facet(tagStart, tagStart + 2, { $type: 'app.bsky.richtext.facet#tag', tag: 't' }),
      facet(2, 2 + blen(url), { $type: 'app.bsky.richtext.facet#link', uri: url }),
    ]);
    expect(rich).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'link', url, text: url },
      { type: 'text', text: ' ' },
      { type: 'hashtag', tag: 't' },
    ]);
  });

  it('重複 facet は先勝ち', () => {
    const url = 'https://example.com';
    const rich = facetsToRich(url, [
      facet(0, blen(url), { $type: 'app.bsky.richtext.facet#link', uri: url }),
      facet(0, 5, { $type: 'app.bsky.richtext.facet#tag', tag: 'x' }),
    ]);
    expect(rich).toEqual([{ type: 'link', url, text: url }]);
  });

  it('範囲超過 facet はスキップしてプレーンテキスト（全体プレーンなら undefined）', () => {
    expect(
      facetsToRich('hello', [facet(0, 999, { $type: 'app.bsky.richtext.facet#link', uri: 'u' })]),
    ).toBeUndefined();
  });

  it('マルチバイト文字の途中に境界が落ちる facet はスキップ', () => {
    // '日' は UTF-8 で 3バイト。byteEnd=1 は文字の途中
    expect(
      facetsToRich('日本語', [facet(0, 1, { $type: 'app.bsky.richtext.facet#link', uri: 'u' })]),
    ).toBeUndefined();
  });

  it('未知の feature はプレーンテキストとして残す', () => {
    expect(facetsToRich('hello', [facet(0, 5, { $type: 'app.bsky.richtext.facet#future' })])).toBeUndefined();
  });

  it('必須フィールド欠落 facet はプレーンテキスト（link に uri 無し）', () => {
    expect(facetsToRich('hello', [facet(0, 5, { $type: 'app.bsky.richtext.facet#link' })])).toBeUndefined();
  });

  it('facets 無し/空は undefined', () => {
    expect(facetsToRich('hello', undefined)).toBeUndefined();
    expect(facetsToRich('hello', [])).toBeUndefined();
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

  it('record#view（引用）→ 外側 linkCard は抽出しないが quote は映射する（docs/quote-display-spec.md）', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: {
            $type: 'app.bsky.embed.record#viewRecord',
            uri: 'at://did:q/app.bsky.feed.post/q1',
            cid: 'cq',
            author: { did: 'did:q', handle: 'q.bsky.social', displayName: 'Q' },
            value: { text: 'quoted', createdAt: '2026-06-30T00:00:00Z' },
            embeds: [
              {
                $type: 'app.bsky.embed.external#view',
                external: { uri: 'https://example.com/nested', title: 'n', description: '' },
              },
            ],
          },
        },
      }),
    );
    expect(post.linkCard).toBeUndefined();
    expect(post.quote?.text).toBe('quoted');
    expect(post.quote?.linkCard).toBeUndefined(); // 引用先の外部カードは描画対象外
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

// --- 引用表示（docs/quote-display-spec.md）/ CW（docs/cw-display-spec.md） ---

function makeViewRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $type: 'app.bsky.embed.record#viewRecord',
    uri: 'at://did:plc:q/app.bsky.feed.post/q1',
    cid: 'cq',
    author: { did: 'did:plc:q', handle: 'q.bsky.social', displayName: 'Q' },
    value: { text: 'quoted body', createdAt: '2026-06-30T09:00:00Z' },
    replyCount: 4,
    repostCount: 5,
    likeCount: 6,
    ...overrides,
  };
}

describe('mapPost の引用抽出（extractQuote）', () => {
  it('record#view の viewRecord → quote に映射（stats・url・createdAt 込み）', () => {
    const post = mapPost(
      makePostView({ embed: { $type: 'app.bsky.embed.record#view', record: makeViewRecord() } }),
    );
    expect(post.quote).toMatchObject({
      id: 'at://did:plc:q/app.bsky.feed.post/q1',
      provider: 'bluesky',
      text: 'quoted body',
      createdAt: '2026-06-30T09:00:00Z',
      stats: { replies: 4, reposts: 5, likes: 6 },
      url: 'https://bsky.app/profile/did:plc:q/post/q1',
    });
    expect(post.quoteUnavailable).toBeUndefined();
  });

  it('recordWithMedia#view → media は外側・record は quote に分離', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.recordWithMedia#view',
          media: {
            $type: 'app.bsky.embed.images#view',
            images: [{ fullsize: 'https://i.png', thumb: 'https://t.png', alt: 'a' }],
          },
          record: { $type: 'app.bsky.embed.record#view', record: makeViewRecord() },
        },
      }),
    );
    expect(post.media).toEqual([{ type: 'image', url: 'https://i.png', alt: 'a' }]);
    expect(post.quote?.text).toBe('quoted body');
  });

  it('引用先 viewRecord の media（embeds[0]）を quote.media に映射', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: makeViewRecord({
            embeds: [
              {
                $type: 'app.bsky.embed.images#view',
                images: [{ fullsize: 'https://qi.png', thumb: 'https://qt.png', alt: '' }],
              },
            ],
          }),
        },
      }),
    );
    expect(post.quote?.media).toEqual([{ type: 'image', url: 'https://qi.png', alt: '' }]);
  });

  it('ネスト引用（引用の引用）は捨てる（1階層のみ）', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: makeViewRecord({
            embeds: [
              { $type: 'app.bsky.embed.record#view', record: makeViewRecord({ uri: 'at://nested' }) },
            ],
          }),
        },
      }),
    );
    expect(post.quote?.quote).toBeUndefined();
  });

  it.each(['viewNotFound', 'viewBlocked', 'viewDetached'])(
    '%s → quoteUnavailable',
    (kind) => {
      const post = mapPost(
        makePostView({
          embed: {
            $type: 'app.bsky.embed.record#view',
            record: { $type: `app.bsky.embed.record#${kind}`, uri: 'at://x', notFound: true },
          },
        }),
      );
      expect(post.quoteUnavailable).toBe(true);
      expect(post.quote).toBeUndefined();
    },
  );

  it('recordWithMedia の不正連鎖（2段目）は展開せず quote 無し', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.recordWithMedia#view',
          media: { $type: 'app.bsky.embed.images#view', images: [] },
          record: {
            $type: 'app.bsky.embed.recordWithMedia#view',
            media: { $type: 'app.bsky.embed.images#view', images: [] },
            record: { $type: 'app.bsky.embed.record#view', record: makeViewRecord() },
          },
        },
      }),
    );
    expect(post.quote).toBeUndefined();
    expect(post.quoteUnavailable).toBeUndefined();
  });

  it('投稿以外のレコード（feed generator）→ skip', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: { $type: 'app.bsky.embed.record#viewGenerator', uri: 'at://gen', displayName: 'G' },
        },
      }),
    );
    expect(post.quote).toBeUndefined();
    expect(post.quoteUnavailable).toBeUndefined();
  });
});

describe('mapPost の CW / url', () => {
  it('self-labels を cw に連結（複数なら ", " 区切り、ADR-0016）', () => {
    const post = mapPost(
      makePostView({ labels: [{ val: 'porn' }, { val: 'graphic-media' }] }),
    );
    expect(post.cw).toBe('porn, graphic-media');
  });

  it('labels 無し → cw 無し', () => {
    expect(mapPost(makePostView()).cw).toBeUndefined();
  });

  it('引用先 viewRecord の labels も cw に映射', () => {
    const post = mapPost(
      makePostView({
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: makeViewRecord({ labels: [{ val: 'sexual' }] }),
        },
      }),
    );
    expect(post.quote?.cw).toBe('sexual');
  });

  it('at:// URI から bsky.app permalink を生成', () => {
    expect(mapPost(makePostView()).url).toBe('https://bsky.app/profile/did/post/abc');
  });

  it('app.bsky.feed.post 以外の URI → url 無し', () => {
    const post = mapPost(makePostView({ uri: 'at://did/app.bsky.feed.like/xyz' }));
    expect(post.url).toBeUndefined();
  });
});

describe('threadViewToResponse（スレッド木の解釈。docs/thread-view-spec.md §4.2）', () => {
  const node = (uri: string, over: Record<string, unknown> = {}) => ({
    $type: 'app.bsky.feed.defs#threadViewPost',
    post: makePostView({ uri, cid: `cid-${uri}`, record: { text: uri }, ...over }),
  });

  it('フォーカス＋祖先を root 先頭に反転して返す', async () => {
    const root = node('at://did/app.bsky.feed.post/root');
    const mid = { ...node('at://did/app.bsky.feed.post/mid'), parent: root };
    const focus = { ...node('at://did/app.bsky.feed.post/focus'), parent: mid };
    const res = threadViewToResponse(focus as never);
    expect(res).not.toBeNull();
    expect(res?.focus.id).toBe('at://did/app.bsky.feed.post/focus');
    expect(res?.ancestors.map((p) => p.id)).toEqual([
      'at://did/app.bsky.feed.post/root',
      'at://did/app.bsky.feed.post/mid',
    ]);
    expect(res?.nextCursor).toBeNull();
  });

  it('子孫を DFS 順＋depth（focus 直下=1）で平坦化する', async () => {
    const r2 = node('at://did/app.bsky.feed.post/r2');
    const r1 = { ...node('at://did/app.bsky.feed.post/r1'), replies: [r2] };
    const r3 = node('at://did/app.bsky.feed.post/r3');
    const focus = { ...node('at://did/app.bsky.feed.post/focus'), replies: [r1, r3] };
    const res = threadViewToResponse(focus as never);
    expect(res?.replies.map((n) => ({ id: n.post?.id, depth: n.depth }))).toEqual([
      { id: 'at://did/app.bsky.feed.post/r1', depth: 1 },
      { id: 'at://did/app.bsky.feed.post/r2', depth: 2 },
      { id: 'at://did/app.bsky.feed.post/r3', depth: 1 },
    ]);
  });

  it('notFound / blocked ノードは unavailable（木構造の連続性は保つ）', async () => {
    const notFound = { $type: 'app.bsky.feed.defs#notFoundPost', notFound: true, uri: 'at://nf' };
    const blocked = { $type: 'app.bsky.feed.defs#blockedPost', blocked: true, uri: 'at://bl' };
    const focus = { ...node('at://did/app.bsky.feed.post/focus'), replies: [notFound, blocked] };
    const res = threadViewToResponse(focus as never);
    expect(res?.replies).toEqual([
      { unavailable: true, depth: 1 },
      { unavailable: true, depth: 1 },
    ]);
  });

  it('フォーカス自体が notFound / blocked → null（ルートが 404 にマップ）', async () => {
    expect(threadViewToResponse({ $type: 'app.bsky.feed.defs#notFoundPost', notFound: true, uri: 'at://x' } as never)).toBeNull();
    expect(threadViewToResponse({ $type: 'app.bsky.feed.defs#blockedPost', blocked: true, uri: 'at://x' } as never)).toBeNull();
  });

  it('祖先の途中が blocked → そこで打ち切り（取得できた祖先のみ root 先頭）', async () => {
    const blocked = { $type: 'app.bsky.feed.defs#blockedPost', blocked: true, uri: 'at://bl' };
    const mid = { ...node('at://did/app.bsky.feed.post/mid'), parent: blocked };
    const focus = { ...node('at://did/app.bsky.feed.post/focus'), parent: mid };
    // 連鎖: focus → mid → blocked（打ち切り。blocked の上は辿らない）
    const res = threadViewToResponse(focus as never);
    expect(res?.ancestors.map((p) => p.id)).toEqual(['at://did/app.bsky.feed.post/mid']);
  });
});
