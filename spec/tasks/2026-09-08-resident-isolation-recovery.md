---
task: resident-isolation-recovery
project: Pagus
kind: 実装
created: 2026-09-08
memory_links:
  - spec/plan/problem_logs/2026-09-08-resident-isolation-concentration.md
---

# 住民の隔離への集中と復帰不能を解消する

## 目的

累計の嫌がらせによって全住民が隔離施設へ集まり、街の仕事や建設が止まる問題を解消する。

## 完了条件

- 隔離の発生条件・解除条件と既存セーブへの適用方針が利用者と合意されている。
- 合意した条件をバックエンドの住民BT・住居状態遷移へ適用する。
- 初期経歴による隔離と、嫌がらせによる隔離を区別して扱う。
- 長時間経過だけで全員が隔離へ収束せず、復帰した住民が職業ルーティンと建設に参加できる。
- 実行許可がある場合のみ、Excubitor経由・本体フォルダ・Concordia claim/releaseで動作を確認する。

## スコープ (編集可ディレクトリ)

- packages/sim/src/
- spec/feature/
- spec/plan/problem_logs/
