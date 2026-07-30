# Bluesky の self-labels を CW テキストとして解釈する

Bluesky には Misskey のような自由文 CW が無く、`com.atproto.label.defs#selfLabels` のみがある。本アプリの書き込み側は既に `contentWarning → self-label 1個` と映射しているため、読み取り側でも `selfLabels.values[]` を `, ` 連結して `Post.cw` に映射し、Misskey と同じ折りたたみ CW として表示する。自分で CW 付き投稿したものが自分の TL で折りたたまれない自己矛盾を避けるため。詳細: [cw-display-spec.md](../cw-display-spec.md)。

## Considered Options

- **self-labels を無視する** — bsky 投稿の CW が一切機能せず、書き込み側（`contentWarning` を送れる）と読み取り側が非対称になるため却下。
- **ラベル値を人間可読名に変換する**（`porn` →「成人向け」等）— 表示は親切だが変換表の保守が発生し、他クライアントの付けた任意ラベル値に追随しきれない。MVP では値をそのまま表示し、必要になったら変換表を追加する。

## Consequences

- `porn` / `graphic-media` 等のトークンが CW ピルにそのまま文字列として表示される。
- bsky の self-labels は本来モデレーション（成人コンテンツフィルタ等）の概念でもある。将来「ラベルを CW 折りたたみではなくコンテンツフィルタとして扱う」必要が出た場合、`Post.cw` への映射を再審する。
