/**
 * sns-client Worker (BFF + Static Assets)
 *
 * /api/* を BFF で処理し、それ以外は静的アセット(SPA)へフォールバック。
 * timeline/media/post はプロバイダ（bluesky/misskey）ごとに dispatch する。
 */
import { API, VIEWS_KV_KEY } from '../../shared/constants';
import type {
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

/** /api/sources: 片方のプロバイダが失敗しても他方は返す（部分障害耐性、ADR-0004 方針） */
async function collectSources(provider: Provider, fn: () => Promise<SourceOption[]>): Promise<SourceCatalogEntry> {
  try {
    return { provider, options: await fn() };
  } catch (e) {
    console.error(`[api/sources:${provider}]`, e);
    return { provider, options: [], error: true };
  }
}

/** プロバイダごとに許容する Source kind（docs/deck-view-spec.md §3） */
const KINDS: Record<string, string[]> = {
  bluesky: ['home', 'list', 'feed'],
  misskey: ['home', 'list', 'antenna', 'channel'],
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

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
  });
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

function isProvider(s: string | null): s is Provider {
  // mastodon は型上予約のみ（未実装）。実装済みの bluesky/misskey だけを受け付け、他は 400 にする
  return s === 'bluesky' || s === 'misskey';
}

/**
 * BFF ルート共通のエラーハンドリング（プロバイダ対応）。
 * - 認証未設定 (Bsky/MisskeyAuthError) → 503
 * - 認証系エラー:
 *   - bluesky → セッション破棄（セルフヒーリング）し 502（次回再ログイン、 transient）
 *   - misskey → 静的トークンのため回復不能 → 401 permanent（クライアントは当該 Source のポーリング停止）
 * - その他 → 502（詳細はサーバ側ログのみ、情報漏洩防止）
 */
async function run(label: string, provider: Provider, fn: () => Promise<unknown>, okStatus = 200): Promise<Response> {
  try {
    return json(await fn(), { status: okStatus });
  } catch (e) {
    if (e instanceof BskyAuthError || e instanceof MisskeyAuthError) return json({ error: e.message }, { status: 503 });
    if (e instanceof MisskeyApiError) return json({ error: e.code ?? 'misskey-error' }, { status: e.status });
    if (isAuthError(e)) {
      if (provider === 'bluesky') {
        resetSession();
        return json({ error: 'auth-retry', provider }, { status: 502 });
      }
      return json({ error: 'auth-failed', provider, permanent: true }, { status: 401 });
    }
    console.error(`[${label}]`, e);
    return json({ error: 'Internal server error' }, { status: 502 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === API.health) {
      const secretsReady = Boolean(env.BSKY_HANDLE && env.BSKY_APP_PASSWORD);
      return json({
        ok: true,
        service: 'sns-client',
        session: secretsReady ? 'configured' : 'missing-secrets',
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === API.views && request.method === 'GET') {
      // KV のカスタム View を優先。未設定・読み取り失敗はプリセットへフォールバック
      try {
        const stored = await env.VIEWS?.get(VIEWS_KV_KEY, 'json');
        if (Array.isArray(stored)) return json(stored);
      } catch (e) {
        console.error('[api/views] KV get failed; fallback to preset', e);
      }
      return json(VIEWS_PRESET);
    }

    if (url.pathname === API.views && request.method === 'PUT') {
      if (!env.VIEWS) return json({ error: 'views storage not configured' }, { status: 503 });
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, { status: 400 });
      }
      const err = validateViews(body);
      if (err) return json({ error: err }, { status: 400 });
      try {
        await env.VIEWS.put(VIEWS_KV_KEY, JSON.stringify(body));
      } catch (e) {
        console.error('[api/views] KV put failed', e);
        return json({ error: 'failed to persist views' }, { status: 502 });
      }
      return json(body);
    }

    if (url.pathname === API.providers && request.method === 'GET') {
      const misskeyConfigured = Boolean(env.MISSKEY_TOKEN);
      const misskeyLimit = misskeyConfigured ? await getComposeCharLimit(env) : 3000;
      const providers: ProviderInfo[] = [
        {
          provider: 'bluesky',
          configured: Boolean(env.BSKY_HANDLE && env.BSKY_APP_PASSWORD),
          compose: { charLimit: 300, unit: 'grapheme' },
        },
        {
          provider: 'misskey',
          configured: misskeyConfigured,
          compose: { charLimit: misskeyLimit, unit: 'char' },
        },
      ];
      return json(providers);
    }

    if (url.pathname === API.timeline && request.method === 'GET') {
      const provider = url.searchParams.get('provider');
      if (!isProvider(provider)) return json({ error: 'invalid provider' }, { status: 400 });
      const kind = url.searchParams.get('kind') ?? 'home';
      if (!KINDS[provider].includes(kind)) return json({ error: 'invalid kind' }, { status: 400 });
      const id = url.searchParams.get('id') ?? undefined;
      if (kind !== 'home' && !id) return json({ error: 'id required' }, { status: 400 });
      const source = { provider, kind, ...(id ? { id } : {}) };
      const cursor = url.searchParams.get('cursor') ?? undefined;
      if (provider === 'bluesky') {
        return run('api/timeline:bluesky', provider, () =>
          bskyTimeline(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD, source, cursor),
        );
      }
      return run('api/timeline:misskey', provider, () => misskeyTimeline(env, source, cursor));
    }

    if (url.pathname === API.sources && request.method === 'GET') {
      const entries = await Promise.all([
        collectSources('bluesky', () => bskySources(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD)),
        collectSources('misskey', () => misskeySources(env)),
      ]);
      return json(entries);
    }

    if (url.pathname === API.media && request.method === 'POST') {
      const provider = url.searchParams.get('provider');
      if (!isProvider(provider)) return json({ error: 'invalid provider' }, { status: 400 });
      const mimeType = request.headers.get('content-type') || 'application/octet-stream';
      const alt = url.searchParams.get('alt') ?? '';
      const bytes = await request.arrayBuffer();
      if (provider === 'bluesky') {
        return run('api/media:bluesky', provider, async () => ({
          blob: await bskyUpload(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD, bytes, mimeType),
        }));
      }
      return run('api/media:misskey', provider, async () => ({
        blob: await misskeyUpload(env, bytes, mimeType, alt),
      }));
    }

    if (url.pathname === API.post && request.method === 'POST') {
      const input = (await request.json().catch(() => null)) as PostInputWire | null;
      if (!input) return json({ error: 'invalid json' }, { status: 400 });
      if (!isProvider(input.provider)) return json({ error: 'invalid provider' }, { status: 400 });
      if (input.provider === 'bluesky') {
        return run('api/post:bluesky', input.provider, () => bskyPost(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD, input), 201);
      }
      return run('api/post:misskey', input.provider, () => misskeyPost(env, input), 201);
    }

    if (url.pathname === API.reactions && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as ReactionRequest | null;
      // リアクション操作は Misskey のみ（Bluesky の like は /api/likes。docs/misskey-reaction-action-spec.md）
      if (!body || body.provider !== 'misskey') return json({ error: 'unsupported provider' }, { status: 400 });
      if (typeof body.postId !== 'string' || body.postId.length === 0) {
        return json({ error: 'invalid postId' }, { status: 400 });
      }
      if (body.reaction !== undefined && (typeof body.reaction !== 'string' || body.reaction.length === 0)) {
        return json({ error: 'invalid reaction' }, { status: 400 });
      }
      const { postId, reaction } = body;
      return run('api/reactions:misskey', 'misskey', async () => {
        await misskeyReact(env, postId, reaction);
        return reaction ? { reaction } : {};
      });
    }

    // --- Like（Bluesky のみ。viewer の like レコード URI でトグル。docs/deck-view-spec.md §6） ---
    if (url.pathname === API.likes && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as LikeRequest | null;
      if (!body || typeof body.uri !== 'string' || typeof body.cid !== 'string') {
        return json({ error: 'invalid body' }, { status: 400 });
      }
      const { uri, cid } = body;
      return run('api/likes:bluesky', 'bluesky', async () => ({ recordUri: await bskyLike(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD, uri, cid) }));
    }

    if (url.pathname === API.likes && request.method === 'DELETE') {
      const body = (await request.json().catch(() => null)) as UnlikeRequest | null;
      if (!body || typeof body.recordUri !== 'string' || body.recordUri.length === 0) {
        return json({ error: 'invalid body' }, { status: 400 });
      }
      const { recordUri } = body;
      return run('api/likes:bluesky:delete', 'bluesky', async () => {
        await bskyUnlike(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD, recordUri);
        return {};
      });
    }

    // --- リポスト（bsky=トグル / misskey=作成のみ。ref はプロバイダ固有の opaque 参照） ---
    if (url.pathname === API.reposts && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as RepostRequest | null;
      if (!body || !isProvider(body.provider)) return json({ error: 'invalid provider' }, { status: 400 });
      if (body.provider === 'bluesky') {
        const ref = body.ref as { uri?: string; cid?: string } | null;
        if (!ref || typeof ref.uri !== 'string' || typeof ref.cid !== 'string') {
          return json({ error: 'invalid ref' }, { status: 400 });
        }
        const { uri, cid } = ref;
        return run('api/reposts:bluesky', 'bluesky', async () => ({
          recordUri: await bskyRepost(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD, uri, cid),
        }));
      }
      if (typeof body.ref !== 'string' || body.ref.length === 0) {
        return json({ error: 'invalid ref' }, { status: 400 });
      }
      const noteId = body.ref;
      return run('api/reposts:misskey', 'misskey', async () => {
        await misskeyRenote(env, noteId);
        return {};
      });
    }

    // リポスト解除は Bluesky のみ（Misskey リノート解除は v1 未対応。docs/deck-view-spec.md §8）
    if (url.pathname === API.reposts && request.method === 'DELETE') {
      const body = (await request.json().catch(() => null)) as UnrepostRequest | null;
      if (!body || typeof body.recordUri !== 'string' || body.recordUri.length === 0) {
        return json({ error: 'invalid body' }, { status: 400 });
      }
      const { recordUri } = body;
      return run('api/reposts:bluesky:delete', 'bluesky', async () => {
        await bskyUnrepost(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD, recordUri);
        return {};
      });
    }

    if (url.pathname === API.emojis && request.method === 'GET') {
      const provider = url.searchParams.get('provider');
      if (provider !== 'misskey') return json({ error: 'unsupported provider' }, { status: 400 });
      return run('api/emojis:misskey', 'misskey', () => misskeyEmojis(env));
    }

    if (url.pathname.startsWith(API.prefix)) {
      return json({ error: 'not implemented', path: url.pathname }, { status: 501 });
    }

    // --- Static assets / SPA fallback ---
    return env.ASSETS.fetch(request);
  },
};
