/**
 * Like / Repost の楽観更新ヘルパー（docs/deck-view-spec.md §6）。
 * viewer のレコード URI 有無を自分の操作状態のソースオブトゥルースとし、
 * カウントと状態を不可分に切り替える。
 */
import type { Post } from '../../../shared/types';

/** Like 状態を切り替える。liked=true にはレコード URI（応答前は暫定値でも可）を渡す */
export function withLike(post: Post, liked: boolean, likeUri?: string): Post {
  const was = Boolean(post.viewer?.likeUri);
  if (was === liked) return post;
  return {
    ...post,
    stats: { ...post.stats, likes: Math.max(0, post.stats.likes + (liked ? 1 : -1)) },
    viewer: { ...post.viewer, likeUri: liked ? likeUri : undefined },
  };
}

/** Repost 状態を切り替える（Bluesky のトグル用） */
export function withRepost(post: Post, reposted: boolean, repostUri?: string): Post {
  const was = Boolean(post.viewer?.repostUri);
  if (was === reposted) return post;
  return {
    ...post,
    stats: { ...post.stats, reposts: Math.max(0, post.stats.reposts + (reposted ? 1 : -1)) },
    viewer: { ...post.viewer, repostUri: reposted ? repostUri : undefined },
  };
}

/** Misskey Renote 成功時にカウントだけ増やす（v1 は作成のみ・状態保持なし） */
export function withRenoteIncrement(post: Post): Post {
  return { ...post, stats: { ...post.stats, reposts: post.stats.reposts + 1 } };
}
