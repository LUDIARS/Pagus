---
task: isolation-policy-v2-verification
project: Pagus
kind: テスト
created: 2026-09-09
memory_links:
  - spec/feature/resident-presence-refinement.md
  - spec/plan/problem_logs/2026-09-09-resident-presence-isolation.md
  - spec/tasks/2026-09-09-presence-runtime-reflection.md
  - spec/tasks/2026-09-08-resident-isolation-recovery.md
---
# 既存隔離の解除と隔離方針v2を確認する

## 目的

隔離属性解除と再隔離防止が保存済み住民へ適用され、住居・職業を壊さず日常へ戻れることを確認する。旧タスク2026-09-08-resident-isolation-recoveryの「初回即時解除しない」「初期経歴による初期隔離」はv2には適用しない。旧タスクの扱いはCc DBで整理し、既存mdを改稿しない。

## 完了条件

- 実行時にマージ済み仕様とコードを読み、検証許可と本体反映を確認する。Cc claim/release・Excubitor・本体限定を守る。
- 旧セーブの隔離が最初の日常処理で一回だけ解除され、家の帰還先・建設待ち・職業・関係が保持されることを確認する。
- 再保存・再起動で移行が繰り返されず、初期住民に隔離が割り当てられないことを確認する。
- 解除後3日の猶予、異なる6時間帯/1日以内の被害、fear>=0.8を確認する。同一segmentの重複と期間外の累積を除外する。
- レビュー後に追加された被害者のfear加算0.14と判定順序を確認し、到達可能性と長期進行での再集中を評価する。
- 新しい隔離も3日平穏で復帰し、移動・仕事を再開することを確認する。条件を作る場合は承認された検証データを用い、本番データを直接書き換えない。

## スコープ (編集可ディレクトリ)

承認された検証環境・データ、spec/plan/problem_logs/の確認記録。仕様変更や本番データ初期化は含めない。
