/**
 * リアクションの楽観パッチ（docs/misskey-reaction-action-spec.md）。
 * Misskey は1ユーザー1反応。reaction あり→付与/置換、なし→解除。
 * count・`me`・`stats.likes`（反応総数）をクライアント側で計算する。
 */
import type { Post } from '../../../shared/types';

export function applyReaction(post: Post, reaction?: string, emojiUrl?: string): Post {
  const reactions = [...(post.reactions ?? [])];
  const me = reactions.find((r) => r.me);
  let likes = post.stats.likes;

  const decrement = (emoji: string) => {
    const i = reactions.findIndex((r) => r.emoji === emoji);
    if (i < 0) return;
    const r = reactions[i];
    if (r.count <= 1) reactions.splice(i, 1);
    else reactions[i] = { ...r, count: r.count - 1, me: false };
  };

  if (!reaction) {
    // 解除
    if (me) {
      decrement(me.emoji);
      likes -= 1;
    }
  } else {
    // 付与/置換
    const t = reactions.find((r) => r.emoji === reaction);
    if (t) {
      if (!t.me) {
        reactions[reactions.indexOf(t)] = { ...t, count: t.count + 1, me: true };
        likes += 1;
      }
      // 既に同じ絵文字で me（通常は UI が解除へトグルするため到達しない）→ 何もしない
    } else {
      reactions.push({ emoji: reaction, count: 1, me: true, ...(emojiUrl ? { emojiUrl } : {}) });
      likes += 1;
    }
    if (me && me.emoji !== reaction) {
      decrement(me.emoji);
      likes -= 1;
    }
  }

  return { ...post, reactions, stats: { ...post.stats, likes } };
}
