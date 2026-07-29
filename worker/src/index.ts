/**
 * sns-client Worker (BFF + Static Assets)
 *
 * /api/* を BFF で処理し、それ以外は静的アセット(SPA)へフォールバック。
 * timeline/media/post はプロバイダ（bluesky/misskey）ごとに dispatch する。
 *
 * ルーティングは Hono（docs/hono-migration-spec.md、ADR-0012）。
 * - 検証失敗は HTTPException を throw（ハンドラは happy path のみ）
 * - エラーマッピングは単一の app.onError に集約（旧 run() と同型）
 * - provider 文脈は c.set('provider', ...) で onError へ受け渡す
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { API, VIEWS_KV_KEY } from '../../shared/constants';
import type {
  DestinationCatalogEntry,
  DestinationOption,
  LikeRequest,
  PostInputWire,
  Provider,
  ProviderInfo,
  ReactionRequest,
  RepostRequest,
  Source,
  SourceCatalogEntry,
  SourceOption,
  UnrepostRequest,
  UnlikeRequest,
  View,
} from '../../shared/types';
import {
  BskyAuthError,
  createPost as bskyPost,
  getTimeline as bskyTimeline,
  likePost as bskyLike,
  listSources as bskySources,
  repostPost as bskyRepost,
  resetSession,
  unlikePost as bskyUnlike,
  unrepostPost as bskyUnrepost,
  uploadMedia as bskyUpload,
} from './bsky';
import {
  MisskeyApiError,
  MisskeyAuthError,
  createPost as misskeyPost,
  getComposeCharLimit,
  getEmojiList as misskeyEmojis,
  getTimeline as misskeyTimeline,
  listDestinations as misskeyDestinations,
  listSources as misskeySources,
  react as misskeyReact,
  renote as misskeyRenote,
  uploadMedia as misskeyUpload,
  type MisskeyEnv,
} from './misskey';

export interface Env extends MisskeyEnv {
  ASSETS: Fetcher;
  VIEWS?: KVNamespace; // カスタム View 定義の保存先（未バインド時はプリセット配信のみ）
  BSKY_HANDLE?: string;
  BSKY_APP_PASSWORD?: string;
}

type AppEnv = { Bindings: Env; Variables: { provider?: Provider } };

/** /api/sources: 片方のプロバイダが失敗しても他方は返す（部分障害耐性、ADR-0004 方針） */
async function collectSources(provider: Provider, fn: () => Promise<SourceOption[]>): Promise<SourceCatalogEntry> {
  try {
    return { provider, options: await fn() };
  } catch (e) {
    console.error(`[api/sources:${provider}]`, e);
    return { provider, options: [], error: true };
  }
}

/** /api/destinations: /api/sources と同じ部分障害耐性（片方失敗しても他方は返す） */
async function collectDestinations(
  provider: Provider,
  fn: () => Promise<DestinationOption[]>,
): Promise<DestinationCatalogEntry> {
  try {
    return { provider, options: await fn() };
  } catch (e) {
    console.error(`[api/destinations:${provider}]`, e);
    return { provider, options: [], error: true };
  }
}

/**
 * PostInputWire.destination の検証（docs/compose-destination-spec.md §4.2）。
 * 問題なければ null、あればエラー文言を返す。省略（home）は常に有効。
 */
function validateDestination(input: PostInputWire): string | null {
  const d = input.destination;
  if (!d) return null;
  if (d.provider !== input.provider) return 'destination.provider mismatch';
  if (d.kind !== 'home' && d.kind !== 'channel') return `invalid destination.kind: ${String(d.kind)}`;
  if (d.kind === 'channel' && (typeof d.id !== 'string' || d.id.length === 0)) return 'destination.id required';
  if (d.kind === 'channel' && d.provider !== 'misskey') return 'channel destination is misskey only';
  return null;
}

/** プロバイダごとに許容する Source kind（docs/deck-view-spec.md §3） */
const KINDS: Record<string, string[]> = {
  bluesky: ['home', 'list', 'feed'],
  misskey: ['home', 'list', 'antenna', 'channel'],
  mixi2: [], // 型上予約のみ。公式 API に TL 取得手段が無いため Source 種別なし（docs/mixi2-integration-spec.md）
  nostr: ['pubkey', 'relay'], // 読み取り専用。両方とも id 必須（docs/nostr-integration-spec.md §5.1）
};

/** 固定プリセットの View 定義（KV 未設定時のフォールバック。ADR-0004） */
const VIEWS_PRESET: View[] = [
  {
    id: 'home',
    name: 'ホーム',
    sources: [
      { provider: 'bluesky', kind: 'home' },
      { provider: 'misskey', kind: 'home' },
    ],
  },
];

/** PUT /api/views の検証。問題なければ null、あればエラー文言を返す */
function validateViews(body: unknown): string | null {
  if (!Array.isArray(body)) return 'body must be an array of views';
  const ids = new Set<string>();
  for (const v of body as View[]) {
    if (typeof v?.id !== 'string' || v.id.length === 0) return 'view.id required';
    if (ids.has(v.id)) return `duplicate view.id: ${v.id}`;
    ids.add(v.id);
    if (typeof v.name !== 'string' || v.name.length === 0) return 'view.name required';
    if (!Array.isArray(v.sources) || v.sources.length === 0) return 'view.sources must not be empty';
    for (const s of v.sources as Source[]) {
      if (!isProvider(s?.provider)) return 'invalid source.provider';
      if (!KINDS[s.provider].includes(s.kind)) return `invalid source.kind: ${s.kind}`;
      if (s.kind !== 'home' && (typeof s.id !== 'string' || s.id.length === 0)) return 'source.id required';
    }
  }
  return null;
}

/** 再ログインを促すべき認証系エラーか */
function isAuthError(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return status === 401 || /ExpiredToken|InvalidToken|AuthFactor|authentication|unauthorized/i.test(String(e));
}

function isProvider(s: string | null | undefined): s is Provider {
  // mastodon・mixi2 は型上予約のみ（未実装）。実装済みの bluesky/misskey/nostr を受け付け、他は 400 にする
  return s === 'bluesky' || s === 'misskey' || s === 'nostr';
}

/** 書き込み（投稿/メディア/リポスト）に対応するプロバイダ。nostr は読み取り専用なので除外 */
function isWritableProvider(s: string | null | undefined): s is 'bluesky' | 'misskey' {
  return s === 'bluesky' || s === 'misskey';
}

const app = new Hono<AppEnv>();

/**
 * Hono の onError は Error インスタンスのみを受ける。プロバイダ関数は非 Error（例: {status: 401}）で
 * reject し得る契約のため、catch-all ミドルウェアで非 Error も同じマッピングへ合流させる。
 */
app.use(async (c, next) => {
  try {
    await next();
  } catch (e) {
    if (e instanceof Error) throw e;
    return mapError(e, c);
  }
});

/**
 * BFF 共通のエラーマッピング（旧 run() と同型、プロバイダ対応）。
 * - HTTPException（検証失敗等）→ その status + {error: message}
 * - 認証未設定 (Bsky/MisskeyAuthError) → 503
 * - 認証系エラー（c.get('provider') で分岐）:
 *   - bluesky → セッション破棄（セルフヒーリング）し 502（次回再ログイン、transient）
 *   - misskey → 静的トークンのため回復不能 → 401 permanent（クライアントは当該 Source のポーリング停止）
 * - その他 → 502（詳細はサーバ側ログのみ、情報漏洩防止）
 */
function mapError(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof BskyAuthError || err instanceof MisskeyAuthError) return c.json({ error: err.message }, 503);
  if (err instanceof MisskeyApiError) {
    return c.json({ error: err.code ?? 'misskey-error' }, err.status as ContentfulStatusCode);
  }
  if (isAuthError(err)) {
    const provider = c.get('provider');
    if (provider === 'bluesky') {
      resetSession();
      return c.json({ error: 'auth-retry', provider }, 502);
    }
    return c.json({ error: 'auth-failed', provider, permanent: true }, 401);
  }
  console.error(`[${c.req.method} ${c.req.path}]`, err);
  return c.json({ error: 'Internal server error' }, 502);
}

app.onError((err, c) => mapError(err, c));

app.get(API.health, (c) => {
  const secretsReady = Boolean(c.env.BSKY_HANDLE && c.env.BSKY_APP_PASSWORD);
  return c.json({
    ok: true,
    service: 'sns-client',
    session: secretsReady ? 'configured' : 'missing-secrets',
    time: new Date().toISOString(),
  });
});

app.get(API.views, async (c) => {
  // KV のカスタム View を優先。未設定・読み取り失敗はプリセットへフォールバック
  try {
    const stored = await c.env.VIEWS?.get(VIEWS_KV_KEY, 'json');
    if (Array.isArray(stored)) return c.json(stored);
  } catch (e) {
    console.error('[api/views] KV get failed; fallback to preset', e);
  }
  return c.json(VIEWS_PRESET);
});

app.put(API.views, async (c) => {
  if (!c.env.VIEWS) throw new HTTPException(503, { message: 'views storage not configured' });
  const body: unknown = await c.req.json().catch(() => undefined);
  if (body === undefined) throw new HTTPException(400, { message: 'invalid json' });
  const err = validateViews(body);
  if (err) throw new HTTPException(400, { message: err });
  try {
    await c.env.VIEWS.put(VIEWS_KV_KEY, JSON.stringify(body));
  } catch (e) {
    console.error('[api/views] KV put failed', e);
    throw new HTTPException(502, { message: 'failed to persist views' });
  }
  return c.json(body);
});

app.get(API.providers, async (c) => {
  const misskeyConfigured = Boolean(c.env.MISSKEY_TOKEN);
  const misskeyLimit = misskeyConfigured ? await getComposeCharLimit(c.env) : 3000;
  const providers: ProviderInfo[] = [
    {
      provider: 'bluesky',
      configured: Boolean(c.env.BSKY_HANDLE && c.env.BSKY_APP_PASSWORD),
      compose: { charLimit: 300, unit: 'grapheme' },
    },
    {
      provider: 'misskey',
      configured: misskeyConfigured,
      compose: { charLimit: misskeyLimit, unit: 'char' },
    },
    // nostr は読み取り専用：シークレット不要で常に configured、compose は持たない（§5.3）
    { provider: 'nostr', configured: true },
  ];
  return c.json(providers);
});

app.get(API.timeline, async (c) => {
  const provider = c.req.query('provider');
  if (!isProvider(provider)) throw new HTTPException(400, { message: 'invalid provider' });
  // nostr はブラウザ直接取得（ADR-0014）。BFF は JP 限定リレーに到達できないため /api/timeline では提供しない。
  // misskey 分岐へフォールスルーしないよう、kind/id 検証より前で明示的に 400 を返す。
  if (provider === 'nostr') throw new HTTPException(400, { message: 'nostr is client-direct: fetch from the browser (ADR-0014)' });
  const kind = c.req.query('kind') ?? 'home';
  if (!KINDS[provider].includes(kind)) throw new HTTPException(400, { message: 'invalid kind' });
  const id = c.req.query('id') ?? undefined;
  if (kind !== 'home' && !id) throw new HTTPException(400, { message: 'id required' });
  const source = { provider, kind, ...(id ? { id } : {}) };
  const cursor = c.req.query('cursor') ?? undefined;
  c.set('provider', provider);
  if (provider === 'bluesky') {
    return c.json(await bskyTimeline(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, source, cursor));
  }
  return c.json(await misskeyTimeline(c.env, source, cursor));
});

app.get(API.sources, async (c) => {
  const entries = await Promise.all([
    collectSources('bluesky', () => bskySources(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD)),
    collectSources('misskey', () => misskeySources(c.env)),
  ]);
  return c.json(entries);
});

app.get(API.destinations, async (c) => {
  // Bluesky は home のみ（list/feed はアグリゲーションで投稿概念なし）。静的に列挙するためカタログ失敗時も home は常に残る
  const entries = await Promise.all([
    collectDestinations('bluesky', async () => [{ destination: { provider: 'bluesky', kind: 'home' }, name: 'ホーム' }]),
    collectDestinations('misskey', () => misskeyDestinations(c.env)),
  ]);
  return c.json(entries);
});

app.post(API.media, async (c) => {
  const provider = c.req.query('provider');
  if (!isWritableProvider(provider)) throw new HTTPException(400, { message: 'invalid provider' });
  const mimeType = c.req.header('content-type') || 'application/octet-stream';
  const alt = c.req.query('alt') ?? '';
  const bytes = await c.req.arrayBuffer();
  c.set('provider', provider);
  if (provider === 'bluesky') {
    return c.json({ blob: await bskyUpload(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, bytes, mimeType) });
  }
  return c.json({ blob: await misskeyUpload(c.env, bytes, mimeType, alt) });
});

app.post(API.post, async (c) => {
  const input = (await c.req.json().catch(() => null)) as PostInputWire | null;
  if (!input) throw new HTTPException(400, { message: 'invalid json' });
  if (!isWritableProvider(input.provider)) throw new HTTPException(400, { message: 'invalid provider' });
  const destErr = validateDestination(input);
  if (destErr) throw new HTTPException(400, { message: destErr });
  c.set('provider', input.provider);
  if (input.provider === 'bluesky') {
    return c.json(await bskyPost(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, input), 201);
  }
  return c.json(await misskeyPost(c.env, input), 201);
});

app.post(API.reactions, async (c) => {
  const body = (await c.req.json().catch(() => null)) as ReactionRequest | null;
  // リアクション操作は Misskey のみ（Bluesky の like は /api/likes。docs/misskey-reaction-action-spec.md）
  if (!body || body.provider !== 'misskey') throw new HTTPException(400, { message: 'unsupported provider' });
  if (typeof body.postId !== 'string' || body.postId.length === 0) {
    throw new HTTPException(400, { message: 'invalid postId' });
  }
  if (body.reaction !== undefined && (typeof body.reaction !== 'string' || body.reaction.length === 0)) {
    throw new HTTPException(400, { message: 'invalid reaction' });
  }
  const { postId, reaction } = body;
  c.set('provider', 'misskey');
  await misskeyReact(c.env, postId, reaction);
  return c.json(reaction ? { reaction } : {});
});

// --- Like（Bluesky のみ。viewer の like レコード URI でトグル。docs/deck-view-spec.md §6） ---
app.post(API.likes, async (c) => {
  const body = (await c.req.json().catch(() => null)) as LikeRequest | null;
  if (!body || typeof body.uri !== 'string' || typeof body.cid !== 'string') {
    throw new HTTPException(400, { message: 'invalid body' });
  }
  const { uri, cid } = body;
  c.set('provider', 'bluesky');
  return c.json({ recordUri: await bskyLike(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, uri, cid) });
});

app.delete(API.likes, async (c) => {
  const body = (await c.req.json().catch(() => null)) as UnlikeRequest | null;
  if (!body || typeof body.recordUri !== 'string' || body.recordUri.length === 0) {
    throw new HTTPException(400, { message: 'invalid body' });
  }
  const { recordUri } = body;
  c.set('provider', 'bluesky');
  await bskyUnlike(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, recordUri);
  return c.json({});
});

// --- リポスト（bsky=トグル / misskey=作成のみ。ref はプロバイダ固有の opaque 参照） ---
app.post(API.reposts, async (c) => {
  const body = (await c.req.json().catch(() => null)) as RepostRequest | null;
  if (!body || !isWritableProvider(body.provider)) throw new HTTPException(400, { message: 'invalid provider' });
  c.set('provider', body.provider);
  if (body.provider === 'bluesky') {
    const ref = body.ref as { uri?: string; cid?: string } | null;
    if (!ref || typeof ref.uri !== 'string' || typeof ref.cid !== 'string') {
      throw new HTTPException(400, { message: 'invalid ref' });
    }
    const { uri, cid } = ref;
    return c.json({ recordUri: await bskyRepost(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, uri, cid) });
  }
  if (typeof body.ref !== 'string' || body.ref.length === 0) {
    throw new HTTPException(400, { message: 'invalid ref' });
  }
  const noteId = body.ref;
  await misskeyRenote(c.env, noteId);
  return c.json({});
});

// リポスト解除は Bluesky のみ（Misskey リノート解除は v1 未対応。docs/deck-view-spec.md §8）
app.delete(API.reposts, async (c) => {
  const body = (await c.req.json().catch(() => null)) as UnrepostRequest | null;
  if (!body || typeof body.recordUri !== 'string' || body.recordUri.length === 0) {
    throw new HTTPException(400, { message: 'invalid body' });
  }
  const { recordUri } = body;
  c.set('provider', 'bluesky');
  await bskyUnrepost(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, recordUri);
  return c.json({});
});

app.get(API.emojis, async (c) => {
  const provider = c.req.query('provider');
  if (provider !== 'misskey') throw new HTTPException(400, { message: 'unsupported provider' });
  c.set('provider', 'misskey');
  return c.json(await misskeyEmojis(c.env));
});

// --- 未知の /api/* は 501、それ以外は静的アセット / SPA フォールバック ---
app.notFound((c) => {
  if (c.req.path.startsWith(API.prefix)) {
    return c.json({ error: 'not implemented', path: c.req.path }, 501);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
