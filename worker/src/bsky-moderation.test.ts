// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtpAgent } from '@atproto/api';
import { blockActor, getMyDid, muteActor, resetSession, unblockActor, unmuteActor } from './bsky';

// AtpAgent だけモックし、実装（getAgent のセッション管理・レコード操作の wiring）は実物を通す
vi.mock('@atproto/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atproto/api')>();
  return { ...actual, AtpAgent: vi.fn() };
});

/** ログイン済みセッションを持つ偽 Agent（Xrpc 呼び出しを vi.fn で受ける） */
function fakeAgent() {
  const putRecord = vi.fn().mockResolvedValue({ data: { uri: 'at://did/app.bsky.graph.block/x' } });
  const deleteRecord = vi.fn().mockResolvedValue({});
  const agent = {
    session: { did: 'did:plc:me', handle: 'h' },
    login: vi.fn().mockResolvedValue({ data: {} }),
    app: {
      bsky: {
        graph: {
          muteActor: vi.fn().mockResolvedValue({}),
          unmuteActor: vi.fn().mockResolvedValue({}),
        },
      },
    },
    com: {
      atproto: {
        repo: { putRecord, deleteRecord, createRecord: vi.fn() },
      },
    },
  };
  return { agent, putRecord, deleteRecord };
}

beforeEach(() => {
  // getAgent のモジュールスコープキャッシュ（agent）をクリアし、毎テスト新規 Agent を作らせる
  resetSession();
  vi.clearAllMocks();
});

describe('ミュート（docs/block-mute-spec.md）', () => {
  it('muteActor: app.bsky.graph.muteActor に DID を渡す', async () => {
    const { agent } = fakeAgent();
    // new で構築できるよう通常関数で返す（コンストラクタがオブジェクトを返すと this の代わりになる）
    vi.mocked(AtpAgent).mockImplementation(function () {
      return agent as never;
    });
    await muteActor('h', 'p', 'did:plc:alice');
    expect(agent.app.bsky.graph.muteActor).toHaveBeenCalledWith({ actor: 'did:plc:alice' });
  });

  it('unmuteActor: app.bsky.graph.unmuteActor に DID を渡す', async () => {
    const { agent } = fakeAgent();
    // new で構築できるよう通常関数で返す（コンストラクタがオブジェクトを返すと this の代わりになる）
    vi.mocked(AtpAgent).mockImplementation(function () {
      return agent as never;
    });
    await unmuteActor('h', 'p', 'did:plc:alice');
    expect(agent.app.bsky.graph.unmuteActor).toHaveBeenCalledWith({ actor: 'did:plc:alice' });
  });
});

describe('ブロック', () => {
  it('blockActor: block レコードを putRecord（rkey=対象 DID）で作成/置換する（再実行も冪等）', async () => {
    const { agent, putRecord } = fakeAgent();
    // new で構築できるよう通常関数で返す（コンストラクタがオブジェクトを返すと this の代わりになる）
    vi.mocked(AtpAgent).mockImplementation(function () {
      return agent as never;
    });
    await blockActor('h', 'p', 'did:plc:alice');
    expect(putRecord).toHaveBeenCalledWith({
      repo: 'did:plc:me',
      collection: 'app.bsky.graph.block',
      rkey: 'did:plc:alice',
      record: { subject: 'did:plc:alice', createdAt: expect.any(String) },
    });
  });

  it('unblockActor: rkey=対象 DID の block レコードを削除する', async () => {
    const { agent, deleteRecord } = fakeAgent();
    // new で構築できるよう通常関数で返す（コンストラクタがオブジェクトを返すと this の代わりになる）
    vi.mocked(AtpAgent).mockImplementation(function () {
      return agent as never;
    });
    await unblockActor('h', 'p', 'did:plc:alice');
    expect(deleteRecord).toHaveBeenCalledWith({
      repo: 'did:plc:me',
      collection: 'app.bsky.graph.block',
      rkey: 'did:plc:alice',
    });
  });

  it('unblockActor: 未ブロック（RecordNotFound）は成功扱いで冪等', async () => {
    const { agent, deleteRecord } = fakeAgent();
    deleteRecord.mockRejectedValue(Object.assign(new Error('RecordNotFound'), { error: 'RecordNotFound' }));
    // new で構築できるよう通常関数で返す（コンストラクタがオブジェクトを返すと this の代わりになる）
    vi.mocked(AtpAgent).mockImplementation(function () {
      return agent as never;
    });
    await expect(unblockActor('h', 'p', 'did:plc:ghost')).resolves.toBeUndefined();
  });

  it('unblockActor: RecordNotFound 以外のエラーはそのまま投げる', async () => {
    const { agent, deleteRecord } = fakeAgent();
    deleteRecord.mockRejectedValue(new Error('network down'));
    // new で構築できるよう通常関数で返す（コンストラクタがオブジェクトを返すと this の代わりになる）
    vi.mocked(AtpAgent).mockImplementation(function () {
      return agent as never;
    });
    await expect(unblockActor('h', 'p', 'did:plc:alice')).rejects.toThrow('network down');
  });
});

describe('getMyDid', () => {
  it('セッションの DID を返す', async () => {
    const { agent } = fakeAgent();
    // new で構築できるよう通常関数で返す（コンストラクタがオブジェクトを返すと this の代わりになる）
    vi.mocked(AtpAgent).mockImplementation(function () {
      return agent as never;
    });
    await expect(getMyDid('h', 'p')).resolves.toBe('did:plc:me');
  });

  it('認証未設定（シークレット欠落）は null を返し、ログインしない', async () => {
    await expect(getMyDid(undefined, undefined)).resolves.toBeNull();
    expect(AtpAgent).not.toHaveBeenCalled();
  });
});
