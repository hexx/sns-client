import { AtpAgent, RichText, type AppBskyFeedDefs, type AtpSessionData } from '@atproto/api';
import type { LinkCard, Media, Post, PostInputWire, TimelineResponse } from '../../shared/types';

const SERVICE = 'https://bsky.social';

// --- セッション管理（単一ユーザー、モジュールスコープキャッシュ） ---
let agent: AtpAgent | undefined;
let loginInFlight: Promise<AtpAgent> | undefined;

export class BskyAuthError extends Error {}

function makeAgent(): AtpAgent {
  return new AtpAgent({
    service: SERVICE,
    // 'update' イベントでトークン自動更新時に呼ばれる（ここではメモリ保持のみ）
    persistSession: (_evt, sess: AtpSessionData | undefined) => {
      void sess;
    },
  });
}

/**
 * セッション付き Agent を返す。
 * - 有効なセッションがあれば再利用（期限切れは Agent 内部で自動リフレッシュ）
 * - なければ App Password で login
 */
export async function getAgent(handle?: string, appPassword?: string): Promise<AtpAgent> {
  if (agent?.session) return agent;
  if (!handle || !appPassword) throw new BskyAuthError('missing-secrets');
  if (!loginInFlight) {
    loginInFlight = (async () => {
      const a = makeAgent();
      await a.login({ identifier: handle, password: appPassword });
      agent = a;
      return a;
    })().finally(() => {
      loginInFlight = undefined;
    });
  }
  return loginInFlight;
}

/** 恒久認証失敗時に外部から呼んで再ログインを促す */
export function resetSession(): void {
  agent = undefined;
}

// --- ドメインモデルへのマッピング ---

function extractMedia(embed: unknown): Media[] {
  const e = embed as { $type?: string; images?: unknown; media?: unknown } | undefined;
  if (!e) return [];
  if (e.$type === 'app.bsky.embed.images#view' && Array.isArray(e.images)) {
    return (e.images as { fullsize?: string; thumb?: string; alt?: string }[]).map((im) => ({
      type: 'image' as const,
      url: im.fullsize || im.thumb || '',
      alt: im.alt || '',
    }));
  }
  if (e.$type === 'app.bsky.embed.recordWithMedia#view' && e.media) {
    return extractMedia(e.media);
  }
  return [];
}

/**
 * LinkCard（外部リンクプレビュー）の抽出。
 * 対象は external#view と、recordWithMedia#view の media が external のケースのみ。
 * 引用（record#view）の引用先カードは対象外（引用描画が未実装のため）。
 */
function extractLinkCard(embed: unknown): LinkCard | undefined {
  const e = embed as { $type?: string; external?: unknown; media?: unknown } | undefined;
  if (!e) return undefined;
  if (e.$type === 'app.bsky.embed.external#view' && e.external) {
    const ext = e.external as { uri?: string; title?: string; description?: string; thumb?: string };
    if (!ext.uri) return undefined;
    return {
      url: ext.uri,
      title: ext.title ?? '',
      description: ext.description ?? '',
      ...(ext.thumb ? { thumbUrl: ext.thumb } : {}),
    };
  }
  if (e.$type === 'app.bsky.embed.recordWithMedia#view' && e.media) {
    return extractLinkCard(e.media);
  }
  return undefined;
}

export function mapPost(pv: AppBskyFeedDefs.PostView): Post {
  const rec = pv.record as { text?: string } | null | undefined;
  return {
    id: pv.uri,
    provider: 'bluesky',
    author: {
      handle: pv.author.handle,
      displayName: pv.author.displayName || pv.author.handle,
      avatarUrl: pv.author.avatar,
    },
    text: rec?.text ?? '',
    createdAt: pv.indexedAt,
    media: extractMedia(pv.embed),
    linkCard: extractLinkCard(pv.embed),
    stats: {
      replies: pv.replyCount ?? 0,
      reposts: pv.repostCount ?? 0,
      likes: pv.likeCount ?? 0,
    },
    source: { uri: pv.uri, cid: pv.cid },
  };
}

// --- BFF 処理本体 ---

export async function getTimeline(
  handle: string | undefined,
  appPassword: string | undefined,
  cursor?: string,
): Promise<TimelineResponse> {
  const a = await getAgent(handle, appPassword);
  const res = await a.getTimeline({ cursor, limit: 30 });
  return {
    posts: res.data.feed.map((f) => mapPost(f.post)),
    nextCursor: res.data.cursor ?? null,
  };
}

/** 画像をアップロードし blob 参照を返す */
export async function uploadMedia(
  handle: string | undefined,
  appPassword: string | undefined,
  bytes: ArrayBuffer,
  mimeType: string,
): Promise<unknown> {
  const a = await getAgent(handle, appPassword);
  const res = await a.uploadBlob(new Uint8Array(bytes), { encoding: mimeType });
  return res.data.blob;
}

/** 投稿レコードを構築する純粋関数（テスト容易化のため分離） */
export function buildPostRecord(input: PostInputWire, rt: RichText): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record: any = { text: rt.text };
  if (rt.facets?.length) record.facets = rt.facets;
  if (input.langs?.length) record.langs = input.langs;

  const images = input.images ?? [];
  const imagesEmbed = images.length
    ? {
        $type: 'app.bsky.embed.images',
        images: images.map((i) => ({ alt: i.alt ?? '', image: i.blob })),
      }
    : null;
  const quoteEmbed = input.quote
    ? { $type: 'app.bsky.embed.record', record: { uri: input.quote.uri, cid: input.quote.cid } }
    : null;

  if (imagesEmbed && quoteEmbed) {
    record.embed = { $type: 'app.bsky.embed.recordWithMedia', media: imagesEmbed, record: quoteEmbed };
  } else if (imagesEmbed) {
    record.embed = imagesEmbed;
  } else if (quoteEmbed) {
    record.embed = quoteEmbed;
  }

  if (input.replyTo) {
    // MVP: 返信対象を root かつ parent とする（トップレベル投稿への返信で正しい）
    const ref = { uri: input.replyTo.uri, cid: input.replyTo.cid };
    record.reply = { root: ref, parent: ref };
  }

  if (input.contentWarning) {
    record.labels = {
      $type: 'com.atproto.label.defs#selfLabels',
      values: [{ val: input.contentWarning }],
    };
  }

  return record;
}

/** 投稿を作成し、統合 Post として返す */
export async function createPost(
  handle: string | undefined,
  appPassword: string | undefined,
  input: PostInputWire,
): Promise<Post> {
  const a = await getAgent(handle, appPassword);

  // リンク/メンション/タグの facets 検出（メンションは DID 解決まで行う）
  const rt = new RichText({ text: input.text });
  await rt.detectFacets(a);

  const record = buildPostRecord(input, rt);
  const images = input.images ?? [];

  const res = await a.post(record);

  // 作成した投稿を再取得し、実際のメディア URL やプロフィール情報を反映する。
  // （a.post の応答は {uri,cid} のみで画像 URL を含まないため、そのままでは UI で画像が壊れる）
  try {
    const view = await a.getPosts({ uris: [res.uri] });
    const pv = view.data.posts[0];
    if (pv) return mapPost(pv);
  } catch (e) {
    console.error('[createPost] refetch failed', e);
  }

  // フォールバック: 手元情報で組み立て（メディア URL は空、UI 側で空 URL は表示しない）
  const createdAt = new Date().toISOString();
  const sess = a.session;
  return {
    id: res.uri,
    provider: 'bluesky',
    author: {
      handle: sess?.handle ?? handle ?? '',
      displayName: sess?.handle ?? handle ?? '',
    },
    text: rt.text,
    createdAt,
    media: images.map((i) => ({ type: 'image' as const, url: '', alt: i.alt })),
    stats: { replies: 0, reposts: 0, likes: 0 },
    source: { uri: res.uri, cid: res.cid },
  };
}
