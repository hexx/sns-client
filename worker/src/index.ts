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
  ModerationRequest,
  PostInputWire,
  Provider,
  ProviderInfo,
  ReactionRequest,
  RepostRequest,
  Source,
  SourceCatalogEntry,
  SourceOption,
  UnfollowRequest,
  UnrepostRequest,
  UnlikeRequest,
  View,
} from '../../shared/types';
import {
  BskyAuthError,
  blockActor as bskyBlock,
  createPost as bskyPost,
  followActor as bskyFollow,
  getMyDid as bskyGetMyDid,
  getNotifications as bskyNotifications,
  getProfile as bskyProfile,
  getProfilePosts as bskyProfilePosts,
  getThread as bskyThread,
  getTimeline as bskyTimeline,
  isAccountUnavailable as bskyAccountUnavailable,
  likePost as bskyLike,
  listSources as bskySources,
  markNotificationsRead as bskyMarkNotificationsRead,
  muteActor as bskyMute,
  repostPost as bskyRepost,
  resetSession,
  unblockActor as bskyUnblock,
  unfollowActor as bskyUnfollow,
  unmuteActor as bskyUnmute,
  unlikePost as bskyUnlike,
  unrepostPost as bskyUnrepost,
  uploadMedia as bskyUpload,
} from './bsky';
import {
  MisskeyApiError,
  MisskeyAuthError,
  blockUser as misskeyBlock,
  createPost as misskeyPost,
  followUser as misskeyFollow,
  getComposeCharLimit,
  getEmojiList as misskeyEmojis,
  getMyUserId as misskeyGetMyUserId,
  getNotifications as misskeyNotifications,
  getProfile as misskeyProfile,
  getProfilePosts as misskeyProfilePosts,
  getThread as misskeyThread,
  getTimeline as misskeyTimeline,
  listDestinations as misskeyDestinations,
  listSources as misskeySources,
  markNotificationsRead as misskeyMarkNotificationsRead,
  muteUser as misskeyMute,
  react as misskeyReact,
  renote as misskeyRenote,
  unblockUser as misskeyUnblock,
  unfollowUser as misskeyUnfollow,
  unmuteUser as misskeyUnmute,
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
  bluesky: ['home', 'list', 'feed', 'notifications'],
  misskey: ['home', 'list', 'antenna', 'channel', 'notifications'],
  mixi2: [], // 型上予約のみ。公式 API に TL 取得手段が無いため Source 種別なし（docs/mixi2-integration-spec.md）
  nostr: ['pubkey', 'relay'], // 読み取り専用。両方とも id 必須（docs/nostr-integration-spec.md §5.1）
};

/**
 * 通知 View（プリセット＋既存ユーザーへの注入用。docs/notifications-spec.md §2、ADR-0020）。
 * 通知 Source 同士（bluesky + misskey）の時系列合成で、Post ストリームとは混ぜない。
 */
const NOTIFICATIONS_VIEW: View = {
  id: 'notifications',
  name: '通知',
  sources: [
    { provider: 'bluesky', kind: 'notifications' },
    { provider: 'misskey', kind: 'notifications' },
  ],
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
  NOTIFICATIONS_VIEW,
];

/**
 * KV のカスタム View に通知 View が無ければ先頭に注入して返す（docs/notifications-spec.md §2）。
 * KV には書き戻さない（PUT /api/views で保存された views に含まれない状態 = 削除済み。再注入しない）。
 */
function withNotificationsView(views: View[]): View[] {
  if (views.some((v) => v.sources.some((s) => s.kind === 'notifications'))) return views;
  return [NOTIFICATIONS_VIEW, ...views];
}

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
      // notifications は id 不要（専用ルート /api/notifications。docs/notifications-spec.md §4）
      if (s.kind !== 'home' && s.kind !== 'notifications' && (typeof s.id !== 'string' || s.id.length === 0)) {
        return 'source.id required';
      }
    }
    // 通知 Source は通知 Source とのみ共存できる（Post ストリームと混ぜない。docs/notifications-spec.md §2、ADR-0020）
    const hasNotifications = v.sources.some((s) => s.kind === 'notifications');
    if (hasNotifications && v.sources.some((s) => s.kind !== 'notifications')) {
      return `notifications view cannot mix post sources: ${v.id}`;
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

/**
 * ブロック・ミュート操作の actorId 検証（docs/block-mute-spec.md §4.1）。
 * bsky は DID（block レコードの rkey に使うため / 等を含む不正値は URI を壊す）、misskey はユーザー ID。
 */
function isValidActorId(provider: 'bluesky' | 'misskey', actorId: string): boolean {
  if (provider === 'bluesky') return /^did:(plc|web):[A-Za-z0-9._:%-]+$/.test(actorId);
  return /^[A-Za-z0-9]{1,64}$/.test(actorId);
}

/** ブロック・ミュート操作のリクエスト検証。不正なら null */
function parseModerationRequest(body: unknown): ModerationRequest | null {
  const b = body as ModerationRequest | null;
  if (!b || !isWritableProvider(b.provider)) return null;
  if (typeof b.actorId !== 'string' || !isValidActorId(b.provider, b.actorId)) return null;
  return { provider: b.provider, actorId: b.actorId };
}

/**
 * ブロック/ミュート操作の共通ハンドラ（4ルートの parse → dispatch → respond を一元化）。
 * provider ごとの実装は bsky=レコード/mute API、misskey=blocking/mute API に dispatch。
 */
async function moderationAction(
  c: Context<AppEnv>,
  action: 'mute' | 'block',
  create: boolean,
): Promise<Response> {
  const body = parseModerationRequest(await c.req.json().catch(() => null));
  if (!body) throw new HTTPException(400, { message: 'invalid body' });
  const { provider, actorId } = body;
  c.set('provider', provider);
  if (provider === 'bluesky') {
    const fn = create
      ? action === 'mute'
        ? bskyMute
        : bskyBlock
      : action === 'mute'
        ? bskyUnmute
        : bskyUnblock;
    await fn(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, actorId);
  } else {
    const fn = create
      ? action === 'mute'
        ? misskeyMute
        : misskeyBlock
      : action === 'mute'
        ? misskeyUnmute
        : misskeyUnblock;
    await fn(c.env, actorId);
  }
  return c.json({});
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
    if (Array.isArray(stored)) return c.json(withNotificationsView(stored));
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
  // 通知は /api/notifications の専用ルート（Post ストリームではない。docs/notifications-spec.md §4）
  if (kind === 'notifications') throw new HTTPException(400, { message: 'notifications is not a timeline source' });
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

app.get(API.thread, async (c) => {
  const provider = c.req.query('provider');
  if (!isProvider(provider)) throw new HTTPException(400, { message: 'invalid provider' });
  // nostr はブラウザ直接解決（ADR-0014、docs/thread-view-spec.md §5）。/api/timeline と同じガード。
  if (provider === 'nostr') throw new HTTPException(400, { message: 'nostr is client-direct: resolve from the browser (ADR-0014)' });
  const refParam = c.req.query('ref');
  if (!refParam) throw new HTTPException(400, { message: 'ref required' });
  let ref: unknown;
  try {
    ref = JSON.parse(refParam);
  } catch {
    throw new HTTPException(400, { message: 'invalid ref' });
  }
  const cursor = c.req.query('cursor') ?? undefined;
  c.set('provider', provider);
  if (provider === 'bluesky') {
    const r = ref as { uri?: string } | null;
    if (!r || typeof r.uri !== 'string') throw new HTTPException(400, { message: 'invalid ref' });
    const thread = await bskyThread(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, r.uri);
    if (!thread) throw new HTTPException(404, { message: 'focus unavailable' });
    return c.json(thread);
  }
  if (typeof ref !== 'string' || ref.length === 0) throw new HTTPException(400, { message: 'invalid ref' });
  try {
    return c.json(await misskeyThread(c.env, ref, cursor));
  } catch (e) {
    // notes/show の 404（NO_SUCH_NOTE）はフォーカス取得不能として 404 を引き継ぐ
    if ((e as { status?: number })?.status === 404) throw new HTTPException(404, { message: 'focus unavailable' });
    throw e;
  }
});

/**
 * profile 系 GET ルートのクエリ検証（provider / id / cursor）。
 * nostr はブラウザ直接解決のため拒否（/api/timeline と同じガード）。不正なら 400 を投げる。
 */
function parseProfileQuery(c: Context<AppEnv>): { provider: 'bluesky' | 'misskey'; id: string; cursor?: string } {
  const provider = c.req.query('provider');
  if (provider === 'nostr') throw new HTTPException(400, { message: 'nostr is client-direct: fetch from the browser (ADR-0014)' });
  if (!isWritableProvider(provider)) throw new HTTPException(400, { message: 'invalid provider' });
  const id = c.req.query('id');
  if (!id || !isValidActorId(provider, id)) throw new HTTPException(400, { message: 'invalid id' });
  return { provider, id, cursor: c.req.query('cursor') ?? undefined };
}

/**
 * プロフィール系 GET の取得不能（bsky の null / misskey の 404）を 404 にマップする共通処理。
 * §9 のプレースホルダ挙動（ステータス・文言）はここに一元化する（docs/profile-view-spec.md §4）。
 */
async function withProfile404<T>(provider: 'bluesky' | 'misskey', bsky: () => Promise<T | null>, misskey: () => Promise<T>): Promise<T> {
  if (provider === 'bluesky') {
    const v = await bsky();
    if (!v) throw new HTTPException(404, { message: 'profile unavailable' });
    return v;
  }
  try {
    return await misskey();
  } catch (e) {
    if (isMisskeyNotFound(e)) throw new HTTPException(404, { message: 'profile unavailable' });
    throw e;
  }
}

/** misskey の取得不能（NO_SUCH_USER / YOU_ARE_BLOCKED）判定。HTTP 404 と業務コード（mkApiWithCode は 409 に正規化）の両対応 */
function isMisskeyNotFound(e: unknown): boolean {
  return (
    (e as { status?: number })?.status === 404 ||
    (e instanceof MisskeyApiError && (e.code === 'NO_SUCH_USER' || e.code === 'YOU_ARE_BLOCKED'))
  );
}

// --- プロフィール（docs/profile-view-spec.md §4/§5。nostr はブラウザ直接のため BFF 非対応） ---

/** id は Author.id（bsky=DID / misskey=userId）。形式検証は parseProfileQuery が担う */
app.get(API.profile, async (c) => {
  const { provider, id } = parseProfileQuery(c);
  c.set('provider', provider);
  return c.json(
    await withProfile404(
      provider,
      () => bskyProfile(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, id),
      () => misskeyProfile(c.env, id),
    ),
  );
});

/** プロフィールの投稿一覧（概要と別ルート。応答は TimelineResponse と同形状。§5/Q12） */
app.get(API.profilePosts, async (c) => {
  const { provider, id, cursor } = parseProfileQuery(c);
  c.set('provider', provider);
  return c.json(
    await withProfile404(
      provider,
      () => bskyProfilePosts(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, id, cursor),
      () => misskeyProfilePosts(c.env, id, cursor),
    ),
  );
});

/**
 * follow 系リクエストの共通検証（provider / actorId の形式。recordUri はあれば保持。不正なら null。docs/profile-view-spec.md §6）
 * ワイヤー契約は UnfollowRequest（recordUri を含む上位互換）で型強制する（POST は provider/actorId のみ使う）。
 */
function parseFollowBody(body: unknown): UnfollowRequest | null {
  const b = body as { provider?: unknown; actorId?: unknown; recordUri?: unknown } | null;
  if (!b) return null;
  // unknown は isWritableProvider の引数型（string|null|undefined）に合わないため先に文字列へ絞る
  const provider: string | undefined = typeof b.provider === 'string' ? b.provider : undefined;
  if (!isWritableProvider(provider)) return null;
  const actorId = b.actorId;
  if (typeof actorId !== 'string') return null;
  if (!isValidActorId(provider, actorId)) return null;
  const recordUri = typeof b.recordUri === 'string' ? b.recordUri : undefined;
  return { provider, actorId, ...(recordUri ? { recordUri } : {}) };
}

// --- フォロー操作（docs/profile-view-spec.md §6。bsky=follow レコード / misskey=following API） ---

app.post(API.follow, async (c) => {
  const body = parseFollowBody(await c.req.json().catch(() => null));
  if (!body) throw new HTTPException(400, { message: 'invalid body' });
  c.set('provider', body.provider);
  if (body.provider === 'bluesky') {
    try {
      return c.json({ recordUri: await bskyFollow(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, body.actorId) });
    } catch (e) {
      // 削除・ブロック等でフォローできない相手は 502 にせず 404（§9 の一貫性）
      if (bskyAccountUnavailable(e)) throw new HTTPException(404, { message: 'actor unavailable' });
      throw e;
    }
  }
  try {
    await misskeyFollow(c.env, body.actorId);
  } catch (e) {
    // misskey も同じ論理条件（取得不能）は 409 ではなく 404 に揃える（§9 の一貫性）
    if (isMisskeyNotFound(e)) throw new HTTPException(404, { message: 'actor unavailable' });
    throw e;
  }
  return c.json({});
});

app.delete(API.follow, async (c) => {
  const body = parseFollowBody(await c.req.json().catch(() => null));
  if (!body) throw new HTTPException(400, { message: 'invalid body' });
  c.set('provider', body.provider);
  if (body.provider === 'bluesky') {
    // 解除は自分の follow レコード URI 指定（viewer.followUri。like 解除と同じ流儀）
    if (typeof body.recordUri !== 'string' || body.recordUri.length === 0) {
      throw new HTTPException(400, { message: 'recordUri required' });
    }
    try {
      await bskyUnfollow(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, body.recordUri);
    } catch (e) {
      // 既に解除済み（レコード消失）は bskyUnfollow 内で成功扱い（冪等）。
      // 削除・ブロック等は POST と同じ 404 に揃える（§9 の一貫性）。
      if (bskyAccountUnavailable(e)) throw new HTTPException(404, { message: 'actor unavailable' });
      throw e;
    }
  } else {
    try {
      await misskeyUnfollow(c.env, body.actorId);
    } catch (e) {
      // 既に解除済み（NOT_FOLLOWING）は目的状態が達成されているため成功扱い（冪等。bsky と同じ扱い）
      if (e instanceof MisskeyApiError && e.code === 'NOT_FOLLOWING') return c.json({});
      // 取得不能（削除済み等）は 409 ではなく 404 に揃える（§9 の一貫性）
      if (isMisskeyNotFound(e)) throw new HTTPException(404, { message: 'actor unavailable' });
      throw e;
    }
  }
  return c.json({});
});

app.get(API.sources, async (c) => {
  const entries = await Promise.all([
    collectSources('bluesky', () => bskySources(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD)),
    collectSources('misskey', () => misskeySources(c.env)),
  ]);
  // 通知 Source は認証不要の静的オプション（カタログ取得失敗時も必ず残る。docs/notifications-spec.md §2）
  for (const entry of entries) {
    if (!entry.options.some((o) => o.source.kind === 'notifications')) {
      entry.options.unshift({ source: { provider: entry.provider as 'bluesky' | 'misskey', kind: 'notifications' }, name: '通知' });
    }
  }
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

// --- 通知（docs/notifications-spec.md。bsky=updateSeen / misskey=markAsRead の差を BFF が吸収） ---

app.get(API.notifications, async (c) => {
  const provider = c.req.query('provider');
  if (!isWritableProvider(provider)) throw new HTTPException(400, { message: 'invalid provider' });
  const cursor = c.req.query('cursor') ?? undefined;
  c.set('provider', provider);
  if (provider === 'bluesky') {
    return c.json(await bskyNotifications(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD, cursor));
  }
  return c.json(await misskeyNotifications(c.env, cursor));
});

/**
 * 通知の全既読（View 表示時の既読化。docs/notifications-spec.md §5）。
 * 未設定 Provider はスキップし、片方の失敗はもう片方に影響させない（ログのみ）。
 */
app.post(API.notificationsRead, async (c) => {
  const jobs: Promise<unknown>[] = [];
  if (c.env.BSKY_HANDLE && c.env.BSKY_APP_PASSWORD) {
    jobs.push(
      bskyMarkNotificationsRead(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD).catch((e) =>
        console.error('[api/notifications/read:bluesky]', e),
      ),
    );
  }
  if (c.env.MISSKEY_TOKEN) {
    jobs.push(misskeyMarkNotificationsRead(c.env).catch((e) => console.error('[api/notifications/read:misskey]', e)));
  }
  await Promise.all(jobs);
  return c.json({});
});

// --- ブロック・ミュート（docs/block-mute-spec.md §4。サーバー側（Provider ネイティブ）方式、ADR-0018） ---

/** 自分のアクター識別子（各 Provider の認証設定があるもののみ）。片方の失敗は null に縮退 */
app.get(API.me, async (c) => {
  const [bsky, misskey] = await Promise.all([
    bskyGetMyDid(c.env.BSKY_HANDLE, c.env.BSKY_APP_PASSWORD).catch((e) => {
      console.error('[api/me:bluesky]', e);
      return null;
    }),
    misskeyGetMyUserId(c.env).catch((e) => {
      console.error('[api/me:misskey]', e);
      return null;
    }),
  ]);
  return c.json({
    me: {
      bluesky: bsky ? { actorId: bsky } : null,
      misskey: misskey ? { actorId: misskey } : null,
    },
  });
});

app.post(API.mutes, (c) => moderationAction(c, 'mute', true));

app.delete(API.mutes, (c) => moderationAction(c, 'mute', false));

app.post(API.blocks, (c) => moderationAction(c, 'block', true));

app.delete(API.blocks, (c) => moderationAction(c, 'block', false));

// --- 未知の /api/* は 501、それ以外は静的アセット / SPA フォールバック ---
app.notFound((c) => {
  if (c.req.path.startsWith(API.prefix)) {
    return c.json({ error: 'not implemented', path: c.req.path }, 501);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
