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
  const who = n.actor?.displayName ? `${n.actor.displayName} さん` : '誰か';
  switch (n.type) {
    case 'mention':
      return `${who}があなたをメンションしました`;
    case 'reply':
      return `${who}があなたに返信しました`;
    case 'quote':
      return `${who}があなたの投稿を引用しました`;
    case 'like':
      return `${who}があなたの投稿にいいねしました`;
    case 'like-via-repost':
      return `${who}がリポスト経由であなたの投稿にいいねしました`;
    case 'repost':
      return `${who}がリポストしました`;
    case 'repost-via-repost':
      return `${who}がリポストをリポストしました`;
    case 'reaction':
      return `${who}がリアクションしました${n.reaction ? ` ${n.reaction}` : ''}`;
    case 'renote':
      return `${who}がリノートしました`;
    case 'follow':
      return `${who}がフォローしました`;
    case 'starterpack-joined':
      return `${who}がスターターパック経由でフォローしました`;
    case 'contact-match':
      return `${who}が連絡先マッチングで見つかりました`;
    case 'receiveFollowRequest':
      return `${who}からフォローリクエストが来ました`;
    case 'followRequestAccepted':
      return `${who}へのフォローリクエストが承認されました`;
    case 'subscribed-post':
      return `${who}の投稿が購読フィードに届きました`;
    case 'pollVote':
      return `${who}があなたのアンケートに投票しました`;
    case 'pollEnded':
      return 'あなたのアンケートが終了しました';
    case 'note':
      return `${who}が投稿しました`;
    case 'app':
      return `${who}からの通知`;
    default:
      return `${who}からの通知`;
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
