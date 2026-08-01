PR 作成フローを進めていますが、**手順4（コードレビュー）で中断**しています。

- ブランチ `feature/thread-view` を作成し、`origin/main` は最新（Already up to date）、lint も clean です。
- しかし `ocr review --audience agent` が失敗しました:
  `Error: review failed: all 15 file review(s) failed — check your LLM configuration and API key`
  （LLM 未設定/API キーの問題で ocr が使えない状態です）

スキルの定めにより、この場合は自己判断でスキップせず確認する必要があります。どうしますか？

1. **ocr の LLM 設定を直してから再実行**（設定を整えていただければ再走します）
2. **コードレビュー（手順4）をスキップして PR 作成を続行**

いずれか指示をお願いします。
