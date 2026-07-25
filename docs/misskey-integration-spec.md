# Misskey 統合 仕様書（misskey.io 閲覧＋投稿）

> 複数 SNS を1画面で扱う PWA クライアント（[sns-client-spec.md](./sns-client-spec.md)）に、
> **misskey.io のタイムライン閲覧＋投稿**を追加し、Bluesky と**1本の統合タイムライン**で扱う拡張の確定仕様。
> 作成: grill-with-docs セッション（全16問合意）に基づく。
> 関連 ADR: [ADR-0004](./adr/0004-view-as-n-sources-client-merge.md) / [ADR-0005](./adr/0005-unified-inline-richtext.md)。用語は [CONTEXT.md](../CONTEXT.md) 参照。

---

## 1. 背景・目的

- Bluesky（MVP）に加え、**misskey.io** のホームタイムライン閲覧と投稿を、アプリを横断せず**同じ1画面**で扱いたい。
- 両 SNS の投稿を**時系列で1本に混ぜた統合タイムライン**で閲覧する。
- 将来の Bluesky カスタムフィード／Misskey アンテナも、同じ機構で扱える設計にする。

## 2. スコープ

### 今回（確定）
- **misskey.io** のホーム（フォロー中）タイムライン閲覧＋投稿。
- Bluesky ホームと Misskey ホームを**1本に合成した統合タイムライン**（View）。
- Misskey のリッチコンテンツ（MFM・カスタム絵文字・reactions・renote/quote・visibility）の表示対応。
- プロバイダ別 compose（计数・MFM・visibility・画像 drive）。

### 将来拡張（今回は対象外）
- クロスポスト（同文を複数プロバイダへ同時投稿。部分失敗UIが伴う）。
- Misskey の local / social(hybrid) / global タイムライン（別 Source 種別）。
- Bluesky カスタムフィード／Misskey アンテナ（別 Source、1ソース View）。
- 利用者カスタム View（Source を選んで作成・命名・保存・同期）。
- MFM 支援UI／カスタム絵文字ピッカー（compose）。
- 引用描画の2階層以上、引用カードのクリック遷移。
- 画像以外（動画/音声）の添付、sensitivity（NSFW）トグル。
- visibility `specified`（特定ユーザー宛＝DM 的、ユーザー選択UIが要る）。
- 他ノートへのリアクション送信（表示はするが、自分が反応する機能は無し）。
- メンションの解決（Bluesky Phase 1.5 と同様。Misskey は MFM で `@user` 手入力可）。

---

## 3. アーキテクチャ（ADR-0004）

**表示単位は View = 1つ以上の Source の集合。** Source とは「1つの Provider に属する1つの投稿ストリーム」（home / Bluesky feed / Misskey antenna など、`{ provider, kind, id? }`）。

- **合成はクライアント側**: 各 Source を別々に fetch・カーソル管理し、`createdAt` 順にマージして1本の Timeline を描画する。
  - 統合ホーム = `[bluesky/home, misskey/home]` の2ソース。
  - 1ソース View（将来の単体フィード/アンテナ）は合成の退化ケース（同じ機構）。
- **View 定義は BFF が `GET /api/views` で単一ソースとして配信**。クライアントは起動時に取得してタブを描画する。これにより PWA の stale キャッシュに左右されず、**スマホでも PC でも同じ View** が見える。当面は Worker 側コードの固定プリセット（形は利用者編集可能にした場合と不変）。
- 合成をサーバでなくクライアントに置く理由: カーソル方式が Provider ごとに異なる（bsky=cursor 文字列 / misskey=`untilId`）ため複合カーソル管理が複雑・部分障害（片方ダウンでも他方表示）に強い・「N ソース合成」1ロジックで将来拡張にそのまま効く。

```
[ スマホ/PC PWA (React SPA) ]
   │ ① GET /api/views → View 定義（Source 集合）を取得
   │ ② Source ごとに GET /api/timeline?provider=&kind=&cursor= を並行 fetch
   │ ③ クライアントで createdAt 順に合成 → 1本の Timeline
   ▼
┌──────────────────────────────────────────────┐
│ Cloudflare Worker (単一: Static Assets + BFF)  │
│  - /api/views, /api/providers                 │
│  - /api/timeline, /api/media, /api/post       │
│  - Bluesky: @atproto/api / Misskey: raw fetch │
└───────────────┬───────────────┬──────────────┘
                ▼               ▼
        Bluesky (bsky.social)  Misskey (misskey.io)
```

認証（ブラウザ↔Worker）は既存どおり Cloudflare Access。認証（Worker↔各SNS）は Worker シークレットに閉じ込める（ブラウザに出さない）。

---

## 4. ドメインモデル変更（`shared/types.ts`）

既存モデル（[CONTEXT.md](../CONTEXT.md)）へ以下を追加・拡張する。

```ts
export type Provider = 'bluesky' | 'misskey' | 'mastodon';

/** 1つの Provider に属する投稿ストリーム（home / feed / antenna ...） */
export type Source = { provider: Provider; kind: string; id?: string };

/** 表示画面の定義。1つ以上の Source の集合（クライアントが合成） */
export type View = { id: string; name: string; sources: Source[] };

export type Author = { handle: string; displayName: string; avatarUrl?: string };

/** 統一インラインリッチテキスト（ADR-0005）。BFF が MFM/facets から生成 */
export type RichSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; url: string; text?: string }
  | { type: 'mention'; handle: string; url?: string }
  | { type: 'hashtag'; tag: string }
  | { type: 'emoji'; name: string; url?: string; char?: string }; // url=カスタム絵文字、char=Unicode

export type Reaction = {
  emoji: string;      // Unicode 絵文字、またはカスタム絵文字名 ":name:"
  emojiUrl?: string;  // カスタム絵文字の画像URL（Unicode なら無し）
  count: number;
  me?: boolean;       // 自分がこの絵文字で反応したか
};

export type Post = {
  id: string;
  provider: Provider;
  author: Author;
  repostedBy?: Author;        // 純粋repost/renote の再共有者（引用では無し）
  text: string;               // プレーンテキスト（フォールバック/検索用）
  rich?: RichSegment[];       // リッチ本文（あれば UI はこちらを描画）
  createdAt: string;
  media: Media[];
  linkCard?: LinkCard;
  quote?: Post;               // 引用で埋め込まれた投稿（描画は1階層のみ）
  stats: { replies: number; reposts: number; likes: number }; // likes=反応総数
  reactions?: Reaction[];     // 絵文字別内訳（Misskey のみ。Bluesky は無し）
  visibility?: 'public' | 'home' | 'followers' | 'specified'; // 任意（Misskey）
  localOnly?: boolean;        // 任意（Misskey）
  ref?: unknown;              // プロバイダ固有の自己参照（bsky={uri,cid} / misskey=noteId）
  source: unknown;            // 生データ退避
};
```

**PostInputWire（投稿リクエスト）の拡張:**
```ts
export type PostInputWire = {
  provider: Provider;          // 投稿先（必須。単一ターゲット）
  text: string;
  images?: { blob: unknown; alt: string }[]; // blob は opaque（bsky=blob / misskey=drive fileId）
  replyTo?: unknown;           // opaque（Post.ref をエコー）。BFF がプロバイダごとに解釈
  quote?: unknown;             // 同上
  contentWarning?: string;     // bsky=self-labels / misskey=cw
  langs?: string[];            // bsky のみ（misskey は無視）
  visibility?: 'public' | 'home' | 'followers'; // misskey のみ（specified は対象外）
  localOnly?: boolean;         // misskey のみ
};
```

---

## 5. BFF API サーフェス

| Method | Path | 内容 |
|---|---|---|
| GET | `/api/health` | 死活（既存） |
| GET | `/api/views` | View 定義一覧 `View[]`（BFF が単一ソースとして配信） |
| GET | `/api/providers` | 利用可能プロバイダ＋compose設定 `{ provider, configured, compose: { charLimit, unit } }[]`。misskey の `charLimit` は `/api/meta` の `maxNoteTextLength` 由来、`unit` は bsky=`grapheme` / misskey=`char` |
| GET | `/api/timeline?provider=&kind=&id=&cursor=` | Source 単位の TL `{ posts, nextCursor }`。`kind=home` が本次の対象、`id` は将来 feed/antenna 用 |
| POST | `/api/media?provider=&alt=` | 画像アップロード。opaque 参照返却（bsky=blob / misskey=drive fileId）。`alt` は misskey で drive の `comment` として使用 |
| POST | `/api/post` | 投稿。body=`PostInputWire`（`provider` 必須） |

- Source は **query パラメータ**で指定（现有の cursor スタイルと整合）。
- `/api/views`（表示の構成）と `/api/providers`（compose 能力）は**分離**。
- `provider` は**投稿 body**、media/timeline は query。
- **Misskey API は raw fetch**（`/api/*` へ JSON POST、ボディに `i: <token>`）。`@misskey-dev/misskey-js` は **MFM パース（`parseMfm`）専用**。

---

## 6. Misskey 接続

- **認証**: API トークン（静的シークレット `MISSKEY_TOKEN`）。ブラウザに出さず Worker に閉じ込める（Bluesky App Password と同型）。OAuth/MiAuth は採用しない（単一ユーザーでは過剰）。
- **インスタンス**: 環境変数 `MISSKEY_INSTANCE_URL`（既定 `https://misskey.io`）。連合型でインスタンス多様なため env 化（コード固定しない）。
- **使用エンドポイント**:
  - `POST /api/notes/timeline`（home=フォロー中。`limit` / `untilId` / `sinceId`）
  - `POST /api/notes/create`（`text` / `cw` / `visibility` / `localOnly` / `fileIds` / `replyId` / `renoteId`）
  - `POST /api/drive/files/create`（multipart: `file` / `comment`=alt → DriveFile.id）
  - `GET|POST /api/meta`（`maxNoteTextLength` 取得、起動時キャッシュ）
- **home の定義**: `/api/notes/timeline`（フォロー中）。Bluesky ホーム（フォロー中）と意味を揃える。local/social/global は将来の別 Source 種別。

---

## 7. 表示マッピング（Misskey Note → Post）

| Misskey Note | → Post | 備考 |
|---|---|---|
| `user` | `author` | |
| `text`（MFM） | `rich`（`parseMfm`→RichSegment[]）＋`text`（プレーン） | ADR-0005。対応: text/link/mention/hashtag/Unicode＆custom emoji。`$[spin]` 等の凝った効果はプレーン縮退。custom emoji の URL は絵文字レジストリで解決（下記） |
| `createdAt` | `createdAt` | |
| `files[]`（DriveFile） | `media`（`url`/`comment`=alt、画像のみ） | |
| `repliesCount` | `stats.replies` | |
| `renoteCount` | `stats.reposts` | |
| `reactions`（Σ） | `stats.likes`（総数） | |
| `reactions`＋`reactionEmojis`＋`myReaction` | `reactions[]`（count 降順、custom は `emojiUrl`、`myReaction` 一致で `me`） | 絵文字別チップ描画用。`emojiUrl` は `reactionEmojis`（リモート custom のみ）→絵文字レジストリ（ローカル custom）の順で解決（下記） |
| `visibility` / `localOnly` | `visibility` / `localOnly` | 非 public/localOnly にバッジ |
| note id | `ref`（＝`replyId`/`renoteId` に使う自己参照） | |
| 生データ | `source` | |

**カスタム絵文字の URL 解決（BFF）:**

Misskey の Note が提供する `reactionEmojis`・`emojis` は**リモートカスタム絵文字のみ**（サーバ実装の仕様。ローカル絵文字の URL は Note に載らない）。そのため BFF は、インスタンスの絵文字レジストリ `POST /api/emojis`（認証不要・ページネーション無し・ローカル絵文字を全件返却・サーバ側 `cacheSec: 3600`）を引き、`name → url` マップを**インメモリで TTL 30分キャッシュ**（シングルフライト付き・lazy 取得）して補完する。

解決ルール（`Reaction.emojiUrl` と `RichSegment`（emoji）の `url` に共通）:

| キー例 | 種別 | 解決順 |
|---|---|---|
| Unicode 絵文字 | — | 解決不要（テキスト描画） |
| `:name:` / `:name@.:` | ローカル custom | `reactionEmojis` → レジストリ `name`（`@.` は除去） |
| `:name@host:`（host≠`.`） | リモート custom | `reactionEmojis[name@host]` のみ。**レジストリへフォールバックしない**（同名別画像のローカル絵文字への誤解決防止） |
| 未解決 | — | `:name:` テキスト描画へ縮退（現行挙動） |

レジストリ取得失敗時はキャッシュ無し・テキスト縮退でタイムライン表示は続行する（絵文字解決は非致命）。

**renote / quote の扱い（Bluesky も同時実装）:**

| ケース | author | repostedBy | text/rich | quote |
|---|---|---|---|---|
| Misskey 純粋renote（text 無し・`renote` 有り） | 元ノート著者 | renote した人 | 元ノート本文 | — |
| Misskey 引用renote（text＋`renote`） | 引用した人 | — | 引用本文 | `note.renote` を mapPost |
| Bluesky リポスト（`reasonRepost`） | 元投稿著者 | `reason.by` | 元投稿本文 | — |
| Bluesky 引用（`record#view` / `recordWithMedia#view` の record 部） | 投稿者 | — | 投稿本文 | `embed.record` を mapPost |

- **引用の描画は1階層**（`quote` の中の `quote` は捨てる＝無限再帰防止）。
- 既知の端境: リポスト/renote を元投稿の `createdAt` で表すため、クライアントの時系列マージで「古い投稿が最近の再共有で上位に見える」順序の揺らぎが理論上ある（现有 bsky リポストと同じ挙動。本次は parity 優先、マージ順序の洗練は別途）。

---

## 8. 投稿（compose）

- **ターゲット選択**: 投稿ボックスに**明示的なプロバイダ選択**（単一ターゲット）。デフォルトは「その View に存在するプロバイダが1つならそれ／複数なら前回使った方」。`/api/providers` の `configured` のプロバイダのみ選択可。クロスポストは将来。
- **プロバイダ別 compose**:
  - Bluesky: **grapheme** 计数（`Intl.Segmenter`）/ 上限 **300** / リンク facets 自動検出（既存）。
  - Misskey: **文字数（length）** 计数 / 上限 **`maxNoteTextLength`**（`/api/meta` から取得、BFF 配信）/ **facets 自動検出は無し**。
- **MFM 入力**: **プレーンな textarea**。入力テキストをそのまま note の `text` として送信（MFM 構文はユーザーが手入力すれば Misskey 側でレンダリング）。MFM 編集UI・絵文字ピッカーは将来。
- **visibility**: Misskey ターゲット時のみセレクタ（`public` / `home` / `followers` ＋ `localOnly` トグル、既定 `public`）。`specified` は対象外。Bluesky はセレクタ無し（现状維持）。
- **CW**: `contentWarning` → bky=self-labels / misskey=`cw`（既存の統一フィールドを流用）。
- **画像**: `/api/media?provider=misskey&alt=` → BFF が `/api/drive/files/create`（`comment`=alt）→ drive `fileId` を `images[].blob`（opaque）で返却。投稿時 `notes/create` に `fileIds`。**最大4枚（統一キャップ）・画像のみ**（動画/音声・NSFW トグルは対象外）。alt の时机差（misskey=upload時 / bsky=create時）は BFF 内部で吸収し、ブラウザ UX は両プロバイダで同一。
- **reply / quote**: クライアントは対象 `Post.ref`（opaque）を `PostInputWire.replyTo` / `quote` に**エコーするだけ**（source を解釈しない＝现有の source キャストを撤去）。BFF がプロバイダごとに解釈（bsky=reply の root/parent・quote の embed record / misskey=`replyId` / `renoteId`）。

---

## 9. 画面・UX

- **統合タイムライン**: View（既定: 統合ホーム=`[bsky/home, misskey/home]`）の各 Source を並行 fetch し、`createdAt` 順に合成して1本で描画。カーソル式無限スクロール（「最古の表示投稿が新しい側の Source を次にページング」）。プルtoリフレッシュ＋手動更新。
- **新着ピル**: 60–90秒の緩やかポーリング。**全 Source 横断の合算**で「新着 N 件」ピル（タップで先頭ジャンプ、**自動挿入しない**＝スクロール位置保護）。
- **View 切替**: 起動時に `/api/views` から取得した View をタブとして表示（当面は固定プリセット）。
- **本文描画**: `rich`（RichSegment[]）があればそれを描画（リンク/メンション/ハッシュタグ/カスタム絵文字＝inline `<img>`）、無ければ `text`。
- **reactions チップ**: `reactions` があれば絵文字チップの横並び（カスタムは `<img>`、Unicode はテキスト＋`count`、`me` は強調、count 降順・全件・折り返し）。その投稿では ❤️ 総数の単独表示は省略。`reactions` が無ければ（Bluesky）`❤️ {stats.likes}`。
- **repostedBy バッジ**: `repostedBy` があればカード先頭に `🔁 {displayName} がリポスト`。
- **引用カード**: `quote` があれば枠付き内包カード（引用先の author＋リッチ本文＋あれば先頭画像サムネ）。表示のみ（遷移なし）・1階層。
- **visibility バッジ**: 非 public（🏠 home / 🔒 followers / ✉️ specified）または localOnly（「ローカルのみ」）の Misskey note に小バッジ。Bluesky は無し。
- **状態表示**: オフラインバナー、API エラーはトースト＋直近キャッシュ表示、投稿失敗時は下書き保持＋リトライ（既存）。

---

## 10. 耐障害性

- **Source 単位で独立**: fetch・ポーリング・指数バックオフ・直近キャッシュ・エラー状態を **Source ごと**に保持。**1 Source が失敗しても他方は表示し続ける（部分表示）**。失敗 Source には「Misskey: 取得失敗」等の表示（トースト/バッジ）＋バックオフ付きでポーリング継続。
- **キャッシュ/オフライン**: Source ごとに直近成功レスポンスをキャッシュ（メモリ＋Cache API）。オフライン時は各 Source のキャッシュを合成して表示。
- **Misskey 認証失敗はセルフヒーリング無し**: 静的 API トークン（bsky の JWT のような refresh 無し）。401/403 は misskey の**恒久認証失敗**として扱い、「Misskey 認証失敗」トースト＋**misskey のポーリング停止**（無限リトライしない）。**bsky は影響を受けず継続**（bsky は既存の回復チェーン `401→refreshSession→createSession` を維持）。復旧はシークレット（`MISSKEY_TOKEN`）再設定。
- **投稿失敗**: 下書き保持＋リトライ（当面は単一ターゲット投稿のみ。クロスポストの部分失敗は将来）。

---

## 11. シークレット／設定

| 名前 | 用途 | 既定 |
|---|---|---|
| `BSKY_HANDLE` / `BSKY_APP_PASSWORD` | Bluesky 認証（既存） | — |
| `MISSKEY_INSTANCE_URL` | Misskey インスタンス URL | `https://misskey.io` |
| `MISSKEY_TOKEN` | Misskey API トークン（設定画面で発行） | — |

ローカルは `.dev.vars`、本番は `wrangler secret put`。

---

## 12. マイルストーン

1. **MK1:** ドメインモデル拡張（`Source`/`View`/`Author`/`RichSegment`/`Reaction`、`Post` の `repostedBy`/`quote`/`reactions`/`visibility`/`ref`、`PostInputWire` の `provider` 等）＋ `/api/views`・`/api/providers`。
2. **MK2:** Misskey 接続（raw fetch クライアント、`MISSKEY_TOKEN`/`MISSKEY_INSTANCE_URL`、`/api/notes/timeline` の Source 実装、`/api/timeline` の source-addressed 化）＋クライアントの Source 並行 fetch・時系列合成・View タブ。
3. **MK3:** 表示リッチ化（統一 RichSegment レンダラ、MFM→RichSegment 変換、reactions チップ、repostedBy バッジ、引用カード1階層＝bsky 側含む、visibility バッジ）。
4. **MK4:** Misskey 投稿（`/api/post` の misskey 対応、drive 画像アップロード、compose のプロバイダ別カウンタ/MFM/visibility、`Post.ref` エコー化で source キャスト撤去）。
5. **MK5:** 耐障害性仕上げ（Source 単位バックオフ/キャッシュ/部分表示、Misskey 認証失敗の停止処理、新着ピル全 Source 合算）。

---

## 13. 前提・リスク

- ⚠️ misskey.io の API 仕様・`maxNoteTextLength`・カスタム絵文字の提供方法の変更に依存（`/api/meta` 動的取得で緩和）。
- ⚠️ Misskey API トークンは権限が大きい。シークレット管理と Cloudflare Access 保護を前提とする（既存方針）。
- ⚠️ 統合タイムラインの合成ページング（N Source のカーソル管理）はクライアント複雑度が上がる（ADR-0004 で意図的に受容）。
- ℹ️ `mastodon` Provider は型上予約済みのまま（本次は実装しない）。
