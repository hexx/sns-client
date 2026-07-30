import { AtpAgent, AppBskyRichtextFacet, RichText, type AppBskyFeedDefs, type AtpSessionData } from '@atproto/api';
import type {
  LinkCard,
  Media,
  Post,
  PostInputWire,
  RichSegment,
  Source,
  SourceOption,
  TimelineResponse,
} from '../../shared/types';

const SERVICE = 'https://bsky.social';
const COL_LIKE = 'app.bsky.feed.like';
const COL_REPOST = 'app.bsky.feed.repost';

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

// --- facets → 統一 RichSegment（ADR-0005、docs/bsky-facets-spec.md） ---

/** 隣接する text セグメントを連結して間引く（misskey.ts の mergeText と同じ方針） */
function mergeText(segs: RichSegment[]): RichSegment[] {
  const out: RichSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (s.type === 'text' && last?.type === 'text') last.text += s.text;
    else out.push(s);
  }
  return out;
}

/**
 * 投稿レコードの facets を統一インラインリッチテキストへ変換する純粋関数。
 * - index は UTF-8 バイトオフセット（TextEncoder/Decoder 経由でスライス）
 * - 対応 feature: link / mention / tag。未知の feature はその範囲をプレーンテキストとして残す
 * - mention は hydration せず、表示テキスト由来の handle と DID 由来の bsky.app URL を付与
 * - 不正範囲・重複 facet はスキップ（先勝ち）。決してスローせず、異常時は undefined
 * - facets 無し/空/結果が全プレーンのみなら undefined（Post.rich を載せない）
 */
export function facetsToRich(text: string, facets: AppBskyRichtextFacet.Main[] | undefined): RichSegment[] | undefined {
  if (!facets?.length) return undefined;
  try {
    const bytes = new TextEncoder().encode(text);
    const decoder = new TextDecoder();
    const sorted = facets.toSorted((a, b) => (a.index?.byteStart ?? 0) - (b.index?.byteStart ?? 0));
    const out: RichSegment[] = [];
    let cursor = 0; // 採用済みのバイト位置
    for (const f of sorted) {
      const start = f.index?.byteStart;
      const end = f.index?.byteEnd;
      // 範囲不正（非数・負値・逆順・超過）や採用済み範囲との重複はスキップ
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        start < cursor ||
        start > end ||
        end > bytes.length
      )
        continue;
      // バイト境界がマルチバイト文字の途中（UTF-8 継続バイト 0x80-0xBF）に落ちる場合はスキップ
      if ((start > 0 && (bytes[start] & 0xc0) === 0x80) || (end < bytes.length && (bytes[end] & 0xc0) === 0x80))
        continue;

      const segText = decoder.decode(bytes.subarray(start, end));
      if (start > cursor) out.push({ type: 'text', text: decoder.decode(bytes.subarray(cursor, start)) });

      let seg: RichSegment = { type: 'text', text: segText };
      for (const ft of f.features ?? []) {
        // 型ガードで union を絞る（ガードは $type のみ検証するため、必須フィールドは明示チェック）。
        // 必須フィールド欠落 facet は seg を代入せずプレーンテキストのまま（壊れリンクを生成しない）
        if (AppBskyRichtextFacet.isLink(ft)) {
          if (ft.uri) seg = { type: 'link', url: ft.uri, text: segText };
          break;
        }
        if (AppBskyRichtextFacet.isMention(ft)) {
          if (ft.did)
            seg = { type: 'mention', handle: segText.replace(/^@/, ''), url: `https://bsky.app/profile/${ft.did}` };
          break;
        }
        if (AppBskyRichtextFacet.isTag(ft)) {
          if (ft.tag) seg = { type: 'hashtag', tag: ft.tag };
          break;
        }
      }
      out.push(seg);
      cursor = end;
    }
    if (cursor < bytes.length) out.push({ type: 'text', text: decoder.decode(bytes.subarray(cursor)) });

    const merged = mergeText(out);
    if (merged.length === 1 && merged[0].type === 'text') return undefined;
    return merged;
  } catch (e) {
    console.error('[bsky] facetsToRich failed', e);
    return undefined;
  }
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
  const rec = pv.record as { text?: string; facets?: AppBskyRichtextFacet.Main[] } | null | undefined;
  const text = rec?.text ?? '';
  const rich = facetsToRich(text, rec?.facets);
  return {
    id: pv.uri,
    provider: 'bluesky',
    author: {
      handle: pv.author.handle,
      displayName: pv.author.displayName || pv.author.handle,
      avatarUrl: pv.author.avatar,
    },
    text,
    ...(rich ? { rich } : {}),
    createdAt: pv.indexedAt,
    media: extractMedia(pv.embed),
    linkCard: extractLinkCard(pv.embed),
    stats: {
      replies: pv.replyCount ?? 0,
      reposts: pv.repostCount ?? 0,
      likes: pv.likeCount ?? 0,
    },
    ref: { uri: pv.uri, cid: pv.cid },
    viewer: buildViewer(pv.viewer),
    source: { uri: pv.uri, cid: pv.cid },
  };
}

/** 自分の操作状態（like/repost レコード URI）を Post.viewer へ整形する。操作無しなら undefined */
function buildViewer(viewer: { like?: string; repost?: string } | undefined): Post['viewer'] {
  if (!viewer?.like && !viewer?.repost) return undefined;
  return {
    ...(viewer.like ? { likeUri: viewer.like } : {}),
    ...(viewer.repost ? { repostUri: viewer.repost } : {}),
  };
}

// --- BFF 処理本体 ---

/**
 * Source 種別（home / list / feed）を Bluesky のフィード API へ dispatch する。
 * list = app.bsky.feed.getListFeed (list AT-URI)、feed = app.bsky.feed.getFeed (generator AT-URI)。
 * 3者とも応答形は { feed: [{post}], cursor } で共通。
 */
export async function getTimeline(
  handle: string | undefined,
  appPassword: string | undefined,
  source: Source,
  cursor?: string,
): Promise<TimelineResponse> {
  const a = await getAgent(handle, appPassword);
  let res: { data: { feed: { post: AppBskyFeedDefs.PostView }[]; cursor?: string } };
  if (source.kind === 'list') {
    if (!source.id) throw new Error('list source requires id');
    res = await a.app.bsky.feed.getListFeed({ list: source.id, cursor, limit: 30 });
  } else if (source.kind === 'feed') {
    if (!source.id) throw new Error('feed source requires id');
    res = await a.app.bsky.feed.getFeed({ feed: source.id, cursor, limit: 30 });
  } else {
    res = await a.getTimeline({ cursor, limit: 30 });
  }
  return {
    posts: res.data.feed.map((f) => mapPost(f.post)),
    nextCursor: res.data.cursor ?? null,
  };
}

/**
 * ピッカー用の選択可能 Source 一覧（ホーム + 自作リスト + saved feeds/pinned lists）。
 * - 自作リスト: app.bsky.graph.getLists(actor=self)
 * - saved feeds / ピン留めリスト（フォロー中リストを含む）: actor preferences の savedFeedsPrefV2 を
 *   getList / getFeedGenerator で hydrate して名前を得る。部分失敗は当該項目をスキップ。
 */
export async function listSources(
  handle: string | undefined,
  appPassword: string | undefined,
): Promise<SourceOption[]> {
  const a = await getAgent(handle, appPassword);
  const options: SourceOption[] = [{ source: { provider: 'bluesky', kind: 'home' }, name: 'ホーム' }];

  const did = a.session?.did;
  if (did) {
    try {
      const res = await a.app.bsky.graph.getLists({ actor: did, limit: 100 });
      for (const l of res.data.lists) {
        options.push({ source: { provider: 'bluesky', kind: 'list', id: l.uri }, name: l.name });
      }
    } catch (e) {
      console.error('[bsky] getLists failed', e);
    }
  }

  try {
    const prefs = await a.app.bsky.actor.getPreferences();
    const saved = prefs.data.preferences.find(
      (p): p is { $type: string; items: { type: string; value: string }[] } =>
        p.$type === 'app.bsky.actor.defs#savedFeedsPrefV2',
    );
    const seen = new Set(options.map((o) => o.source.id).filter(Boolean));
    const items = (saved?.items ?? []).filter((it) => (it.type === 'list' || it.type === 'feed') && !seen.has(it.value));
    await Promise.all(
      items.map(async (it) => {
        try {
          if (it.type === 'list') {
            const r = await a.app.bsky.graph.getList({ list: it.value, limit: 1 });
            options.push({ source: { provider: 'bluesky', kind: 'list', id: it.value }, name: r.data.list.name });
          } else {
            const r = await a.app.bsky.feed.getFeedGenerator({ feed: it.value });
            options.push({
              source: { provider: 'bluesky', kind: 'feed', id: it.value },
              name: r.data.view.displayName,
            });
          }
        } catch (e) {
          console.error(`[bsky] hydrate ${it.type} failed`, e);
        }
      }),
    );
  } catch (e) {
    console.error('[bsky] getPreferences failed', e);
  }

  return options;
}

// --- Like / Repost 操作（docs/deck-view-spec.md §6。自分の操作は viewer のレコード URI でトグルする） ---

function rkeyOf(recordUri: string): string {
  // at://did/collection/rkey → rkey
  const rkey = recordUri.split('/').pop();
  if (!rkey) throw new Error(`invalid record uri: ${recordUri}`);
  return rkey;
}

async function createRecord(
  handle: string | undefined,
  appPassword: string | undefined,
  collection: string,
  record: Record<string, unknown>,
): Promise<string> {
  const a = await getAgent(handle, appPassword);
  const did = a.session?.did;
  if (!did) throw new BskyAuthError('no-session');
  const res = await a.com.atproto.repo.createRecord({
    repo: did,
    collection,
    record: { ...record, createdAt: new Date().toISOString() },
  });
  return res.data.uri;
}

async function deleteRecord(
  handle: string | undefined,
  appPassword: string | undefined,
  collection: string,
  recordUri: string,
): Promise<void> {
  const a = await getAgent(handle, appPassword);
  const did = a.session?.did;
  if (!did) throw new BskyAuthError('no-session');
  await a.com.atproto.repo.deleteRecord({ repo: did, collection, rkey: rkeyOf(recordUri) });
}

/** Like を作成し、自分の like レコード URI を返す */
export async function likePost(
  handle: string | undefined,
  appPassword: string | undefined,
  uri: string,
  cid: string,
): Promise<string> {
  return createRecord(handle, appPassword, COL_LIKE, { subject: { uri, cid } });
}

/** Like を解除する（自分の like レコード URI 指定） */
export async function unlikePost(
  handle: string | undefined,
  appPassword: string | undefined,
  recordUri: string,
): Promise<void> {
  return deleteRecord(handle, appPassword, COL_LIKE, recordUri);
}

/** Repost を作成し、自分の repost レコード URI を返す */
export async function repostPost(
  handle: string | undefined,
  appPassword: string | undefined,
  uri: string,
  cid: string,
): Promise<string> {
  return createRecord(handle, appPassword, COL_REPOST, { subject: { uri, cid } });
}

/** Repost を解除する（自分の repost レコード URI 指定） */
export async function unrepostPost(
  handle: string | undefined,
  appPassword: string | undefined,
  recordUri: string,
): Promise<void> {
  return deleteRecord(handle, appPassword, COL_REPOST, recordUri);
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
  const quoteRef = input.quote as { uri: string; cid: string } | undefined;
  const quoteEmbed = quoteRef
    ? { $type: 'app.bsky.embed.record', record: { uri: quoteRef.uri, cid: quoteRef.cid } }
    : null;

  if (imagesEmbed && quoteEmbed) {
    record.embed = { $type: 'app.bsky.embed.recordWithMedia', media: imagesEmbed, record: quoteEmbed };
  } else if (imagesEmbed) {
    record.embed = imagesEmbed;
  } else if (quoteEmbed) {
    record.embed = quoteEmbed;
  }

  const replyRef = input.replyTo as { uri: string; cid: string } | undefined;
  if (replyRef) {
    // MVP: 返信対象を root かつ parent とする（トップレベル投稿への返信で正しい）
    const ref = { uri: replyRef.uri, cid: replyRef.cid };
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
  const fallbackRich = facetsToRich(rt.text, rt.facets);
  return {
    id: res.uri,
    provider: 'bluesky',
    author: {
      handle: sess?.handle ?? handle ?? '',
      displayName: sess?.handle ?? handle ?? '',
    },
    text: rt.text,
    ...(fallbackRich ? { rich: fallbackRich } : {}),
    createdAt,
    media: images.map((i) => ({ type: 'image' as const, url: '', alt: i.alt })),
    stats: { replies: 0, reposts: 0, likes: 0 },
    source: { uri: res.uri, cid: res.cid },
  };
}
