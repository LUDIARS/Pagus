---
task: presence-court-visual-verification
project: Pagus
kind: テスト
created: 2026-09-09
memory_links:
  - spec/feature/resident-presence-refinement.md
  - spec/tasks/2026-09-09-presence-runtime-reflection.md
  - spec/feature/faction-trial.md
---
# 画角・種族モデル・裁判の言い合い演出を確認する

## 目的

住民の顔と衣服が読み取れる距離で観察でき、裁判では発言順・話者・身振りが一致することを確認する。既存の勢力裁判ルール確認とは分け、今回変更した表示を対象とする。

## 完了条件

- 本体反映と動作確認の明示許可を確認する。必要な起動はCc claim/releaseとExcubitor経由・本体のみで行う。
- PCと狭い画面で初期zoom 4.5と拡大上限8、区画移動・リセット後の画角、住民やUIの見切れを確認する。
- 熊・兎・蛇・梟などの体形、顔、羽毛、衣服の差を確認し、ネジつき(mixed part `clockwork`)のハイライトなし・獣つき(同 `hybrid`)の赤目が保たれることを確認する。
- 裁判で複数住民の発言が順番に表示され、告発/被告の色、名札強調、向き、身振り、カメラ追従が実際の話者に一致する。
- 同一フレーム再受信で発言が重複せず、裁判終了・事件切替・再接続で古い会話が残らないこと、減速モーション設定を確認する。
- 画面資料と問題点を記録し、Discord共有時は添付して配送確認する。確認のため本番住民を処刑・教育しない。

## スコープ (編集可ディレクトリ)

承認された画面・検証データ、spec/plan/problem_logs/の確認記録。発見した修正は別途スコープ化する。
