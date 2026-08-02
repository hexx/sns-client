/**
 * 通知 View の判定と文言・アイコン（docs/notifications-spec.md §2/§6）。
 * Notification の3分類（投稿を伴う / actor のみ / テキストのみ）は type でなくフィールドの有無で判定する。
 */
import type { Notification, NotificationType, View } from '../../../shared/types';

/** View が「通知のみ」の構成か（通知 Source は通知 Source とのみ共存。docs/notifications-spec.md §2、ADR-0020） */
export function isNotificationsView(view: View): boolean {
  return view.sources.length > 0 && view.sources.every((s) => s.kind === 'notifications');
}

/** 通知カードの種別アイコン（未対応タイプはベルに縮退）。key は NotificationType に限定する */
export const NOTIF_ICON: Partial<Record<NotificationType, string>> = {
  mention: '@',
  reply: '↩️',
  quote: '❝',
  like: '❤️',
  'like-via-repost': '❤️',
  repost: '🔁',
  'repost-via-repost': '🔁',
  renote: '🔁',
  reaction: '🎉',
  follow: '👤',
  'starterpack-joined': '👤',
  'contact-match': '📇',
  receiveFollowRequest: '👤',
  followRequestAccepted: '👤',
  pollVote: '📊',
  pollEnded: '📊',
  note: '📝',
  'subscribed-post': '📮',
  app: '🤖',
  verified: '✅',
  unverified: '⚠️',
  achievementEarned: '🏆',
  roleAssigned: '🎖️',
  chatRoomInvitationReceived: '💬',
  exportCompleted: '📦',
  login: '🔐',
  createToken: '🔑',
  test: '🧪',
  scheduledNotePosted: '⏰',
  scheduledNotePostFailed: '⏰',
};

/** 通知カードの表示文言（テキストのみ通知は BFF 合成済みの text を優先。docs/notifications-spec.md §6） */
export function notifText(n: Notification): string {
  if (n.text) return n.text;
  // actor 名を除いた本文（notifTextBody）に前置きを足すだけで合成する（文言の二重管理を避ける。§8.1）
  if (n.type === 'pollEnded') return notifTextBody(n); // actor を伴わない文言は前置きを付けない
  const who = n.actor?.displayName ? `${n.actor.displayName} さん` : '誰か';
  return `${who}${notifTextBody(n)}`;
}

/**
 * 通知カードの本文（actor 名の部分を除いた残り。docs/profile-view-spec.md §8.1）。
 * actor 名はカード内で別要素（クリックでプロフィールを開く）として描画するため、
 * notifText の先頭の「◯◯ さん」を取り除いた形を返す。text のみ通知は全文をそのまま返す。
 */
export function notifTextBody(n: Notification): string {
  if (n.text) return n.text;
  switch (n.type) {
    case 'mention':
      return 'があなたをメンションしました';
    case 'reply':
      return 'があなたに返信しました';
    case 'quote':
      return 'があなたの投稿を引用しました';
    case 'like':
      return 'があなたの投稿にいいねしました';
    case 'like-via-repost':
      return 'がリポスト経由であなたの投稿にいいねしました';
    case 'repost':
      return 'がリポストしました';
    case 'repost-via-repost':
      return 'がリポストをリポストしました';
    case 'reaction':
      return `がリアクションしました${n.reaction ? ` ${n.reaction}` : ''}`;
    case 'renote':
      return 'がリノートしました';
    case 'follow':
      return 'がフォローしました';
    case 'starterpack-joined':
      return 'がスターターパック経由でフォローしました';
    case 'contact-match':
      return 'が連絡先マッチングで見つかりました';
    case 'receiveFollowRequest':
      return 'からフォローリクエストが来ました';
    case 'followRequestAccepted':
      return 'へのフォローリクエストが承認されました';
    case 'subscribed-post':
      return 'の投稿が購読フィードに届きました';
    case 'pollVote':
      return 'があなたのアンケートに投票しました';
    case 'pollEnded':
      return 'あなたのアンケートが終了しました';
    case 'note':
      return 'が投稿しました';
    case 'app':
      return 'からの通知';
    default:
      return 'からの通知';
  }
}

/** タイトル等に使う type の人間可読ラベル（デバッグ・将来のフィルタ用） */
export function typeLabel(t: NotificationType): string {
  switch (t) {
    case 'mention':
      return 'メンション';
    case 'reply':
      return '返信';
    case 'quote':
      return '引用';
    case 'like':
    case 'like-via-repost':
      return 'いいね';
    case 'repost':
    case 'repost-via-repost':
    case 'renote':
      return 'リポスト';
    case 'reaction':
      return 'リアクション';
    case 'follow':
    case 'starterpack-joined':
    case 'contact-match':
    case 'receiveFollowRequest':
    case 'followRequestAccepted':
      return 'フォロー';
    case 'pollVote':
    case 'pollEnded':
      return 'アンケート';
    case 'note':
    case 'subscribed-post':
      return '投稿';
    case 'app':
      return 'アプリ';
    case 'verified':
    case 'unverified':
      return '認証';
    case 'achievementEarned':
      return '実績';
    case 'roleAssigned':
      return 'ロール';
    case 'chatRoomInvitationReceived':
      return 'チャット';
    case 'exportCompleted':
      return 'エクスポート';
    case 'login':
      return 'ログイン';
    case 'createToken':
      return 'トークン';
    case 'test':
      return 'テスト';
    case 'scheduledNotePosted':
    case 'scheduledNotePostFailed':
      return '予約投稿';
    default:
      return '通知';
  }
}
