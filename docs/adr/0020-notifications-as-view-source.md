# 通知は View/Source 機構に載せ、通知同士の合成のみ許可する

通知は独立画面（モーダル・ルーター）ではなく、既存の View/Source 機構に Source kind `notifications` として統合する（[notifications-spec.md](../notifications-spec.md) §2）。プリセット View「通知」（bluesky + misskey の時系列合成）を常設し、KV にカスタム View がある既存ユーザーには `/api/views` の配信時に通知 View が無ければ先頭に注入して返す（KV には書き戻さない。`PUT /api/views` で保存された views に含まれない状態 = 削除済みとして再注入しない。カタログから再追加できる）。

**合成ルール**: 通知 Source は通知 Source とのみ共存できる。Post ストリーム（home / antenna / list / feed 等）とは混ぜない。`PUT /api/views` の検証に追加する。通知は Post と別モデル（ADR-0019）のため、時系列合成に混ぜると描画が破綻する。

**既読管理**: 「View に表示された瞬間に全既読」（bsky: `updateSeen` / misskey: `markAsRead: true`）を採用する。個別既読は両 Provider の API に存在しない（bsky は既読位置記録のみ、misskey は一括のみ）ため実現不能。未読数は非表示中も既存ポーリング機構で更新し、モバイルのタブバッジに出す。タイムラインの新着ピル（unread-divider-spec）は通知には適用しない。

**Considered Options**
- 独立画面（モーダル）: Thread / Compose とのモーダル2重化が生じ、スマホ pager のタブバッジと整合しないため不採用。
- 固定ベルアイコン: View 機構の外に置くためデスクトップとスマホで別実装になるため不採用。
- 既存ユーザーへの自動注入なし: 通知に気づけないため不採用（「削除すると再注入されない」ことで明示的な意思を尊重する）。

**Consequences**
- デッキは全カラム常時表示のため、デスクトップでは通知カラムが表示中 = 常に既読になり、カラムヘッダーバッジは通常 0 になる。バッジの主な受け皿はモバイルの非アクティブタブ。
- Misskey の `i/notifications` は `markAsRead` のデフォルトが `true` のため、ポーリング側は `markAsRead: false` を明示し、既読化は専用ルート（`POST /api/notifications/read`）に閉じる。
