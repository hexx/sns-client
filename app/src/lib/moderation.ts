/**
 * ブロック・ミュートのクライアント側状態（docs/block-mute-spec.md）。
 * - 非表示セット: サーバー側で成立した block/mute のミラー。セッション内のみ・永続化しない（§5.4）。
 * - アクション: BFF を呼び、成功したら非表示セットへ追加し、トースト（取り消し付き）を発火（§5.3）。
 * - 自分のアクター ID（/api/me）: 自分の投稿への操作項目の非表示判定（§5.1）。
 */
import { api } from '../api';
import type { MeResponse, Post, Provider } from '../../../shared/types';

export type ModerationToast = { message: string; undo?: () => void };

/** アクターのグローバル識別子（プロバイダをまたぐ衝突回避） */
export function actorKey(provider: Provider, actorId: string): string {
  return `${provider}:${actorId}`;
}

/**
 * 非表示セットのキー。mute と block を別キーで管理する
 * （両方適用した後に片方だけ取り消しても、もう片方の非表示は維持される。docs/block-mute-spec.md §5.3）。
 */
type Action = 'mute' | 'block';
function hideKey(action: Action, key: string): string {
  return `${action}:${key}`;
}

// --- 非表示セット（セッション内のみ。リロードで消える） ---
const hiddenActors = new Set<string>();
const hiddenListeners = new Set<() => void>();
const inflight = new Set<string>(); // 同一アクターへの実行中ガード（二重送信・取り消し競合の防止）

/** この投稿の著者がブロック/ミュート済みか（§5.4 の描画時フィルタ） */
export function isHiddenPost(post: Post): boolean {
  const k = actorKey(post.provider, post.author.id);
  return hiddenActors.has(hideKey('mute', k)) || hiddenActors.has(hideKey('block', k));
}

/** 非表示セットの変化を購読する（Timeline/Thread の再描画用）。解除関数を返す */
export function subscribeHidden(fn: () => void): () => void {
  hiddenListeners.add(fn);
  return () => {
    hiddenListeners.delete(fn);
  };
}

function notifyHidden(): void {
  for (const fn of hiddenListeners) fn();
}

// --- トースト（App が購読して描画。取り消しは約10秒のウィンドウ、§5.3） ---
const toastListeners = new Set<(t: ModerationToast) => void>();

export function subscribeModerationToasts(fn: (t: ModerationToast) => void): () => void {
  toastListeners.add(fn);
  return () => {
    toastListeners.delete(fn);
  };
}

function emitToast(message: string, undo?: () => void): void {
  const t: ModerationToast = { message, undo };
  for (const fn of toastListeners) fn(t);
}

// --- 自分のアクター ID（/api/me。lazy。失敗時はキャッシュせず次回再試行） ---
let mePromise: Promise<MeResponse | null> | null = null;

export function loadMe(): Promise<MeResponse | null> {
  if (!mePromise) {
    mePromise = api.me().catch((e) => {
      console.error('[moderation] /api/me failed', e);
      mePromise = null; // 一時的な失敗で自分の投稿判定が永久に壊れないようにする（§5.1）
      return null;
    });
  }
  return mePromise;
}

/** その投稿の著者が自分自身か（自分の投稿ではミュート/ブロック項目を出さない。§5.1） */
export async function isOwnPost(post: Post): Promise<boolean> {
  if (post.provider !== 'bluesky' && post.provider !== 'misskey') return false;
  const me = await loadMe();
  return me?.me[post.provider]?.actorId === post.author.id;
}

// --- アクション（BFF 呼び出し → 非表示セット更新 → トースト。失敗時は状態を変えずエラートースト） ---

function runAction(
  action: Action,
  provider: 'bluesky' | 'misskey',
  actorId: string,
  handle: string,
  act: () => Promise<unknown>,
  undoAct: () => Promise<unknown>,
): void {
  const label = action === 'mute' ? 'ミュート' : 'ブロック';
  const key = hideKey(action, actorKey(provider, actorId));
  if (inflight.has(key)) return; // 同一操作の二重送信を防ぐ
  inflight.add(key);
  const mention = handle ? `@${handle}` : 'このユーザー';
  void (async () => {
    try {
      await act();
      hiddenActors.add(key);
      notifyHidden();
      emitToast(`${mention} を${label}しました`, () => {
        void (async () => {
          try {
            await undoAct();
            hiddenActors.delete(key); // 自分の操作キーだけを消す（他方の操作による非表示は維持）
            notifyHidden();
            emitToast(`${mention} の${label}を取り消しました`);
          } catch {
            emitToast(`${label}の取り消しに失敗しました`);
          }
        })();
      });
    } catch (e) {
      console.error(`[moderation] ${label} failed`, e);
      emitToast(`${label}に失敗しました`);
    } finally {
      inflight.delete(key);
    }
  })();
}

/** ユーザーをミュートする（即実行＋トースト。対象は投稿者。§5.2 / §6） */
export function muteUser(post: Post): void {
  if (post.provider !== 'bluesky' && post.provider !== 'misskey') return;
  const { provider, author } = post;
  runAction(
    'mute',
    provider,
    author.id,
    author.handle,
    () => api.mute(provider, author.id),
    () => api.unmute(provider, author.id),
  );
}

/** ユーザーをブロックする（確認ダイアログは UI 側。§5.2） */
export function blockUser(post: Post): void {
  if (post.provider !== 'bluesky' && post.provider !== 'misskey') return;
  const { provider, author } = post;
  runAction(
    'block',
    provider,
    author.id,
    author.handle,
    () => api.block(provider, author.id),
    () => api.unblock(provider, author.id),
  );
}

/** テスト用: モジュール状態（非表示セット・リスナー・キャッシュ）を初期化する */
export function resetModerationForTests(): void {
  hiddenActors.clear();
  hiddenListeners.clear();
  toastListeners.clear();
  inflight.clear();
  mePromise = null;
}
