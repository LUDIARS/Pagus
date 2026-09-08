---
task: presence-anatomia-followup
project: Pagus
kind: レビュー
created: 2026-09-09
memory_links:
  - spec/feature/resident-presence-refinement.md
  - spec/domains/client-ui-pixijs.domain.json
  - spec/domains/behavior-engine-black-box-bt.domain.json
---
# 住民表示変更のAnatomia未分類・孤立所見を整理する

## 目的

マージコミット77bda0be0313に対するAnatomiaの未分類41アンカー・孤立1関数を具体的な追跡項目へ落とし込む。所見だけで不要コードとは断定しない。

## 完了条件

- 保存済みレビュー結果から41アンカーと孤立関数1件の識別子・ファイル・行・対象コミットを特定する。
- 孤立関数はnew・コールバック・イベント・ライフサイクル接続を調べ、呼び出し漏れか解析上の未検出かを切り分ける。既存Pf TODOとの重複を避けて追跡する。
- 未分類アンカーはPfに登録されたAnatomiaビジネスドメインとコア4候補を参照し、program層の分類不足と意味ドメインの未登録を混同しない。
- 根拠と必要な分類・仕様リンク修正を記録する。コード修正が必要なら別の具体的タスクへ分解する。
- complexityのlegacy aggregate所見は新旧function snapshotの有無を確認し、比較できない数値を改善済みの証拠にしない。

## スコープ (編集可ディレクトリ)

Anatomia/Revisor/Pfの読み取り、Pfの追跡項目、spec/plan/problem_logs/の調査記録。テスト・再起動・不要コード削除は含めない。
