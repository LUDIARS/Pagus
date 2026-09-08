---
task: presence-runtime-reflection
project: Pagus
kind: 雑用
created: 2026-09-09
memory_links:
  - spec/feature/resident-presence-refinement.md
---
# 住民表示・隔離方針v2を本体へ反映する

## 目的

マージコミット77bda0be0313の変更を、履歴と住民データを保持して稼働環境へ届ける。作成時の本体HEADは5e7c0daで、対象コミットの反映を確認できていない。

memory_linksのspec/feature/resident-presence-refinement.mdは77bda0be0313で追加されたファイルで、本タスク完了までは本体に存在しない。

## 完了条件

- 実行時に本体のbranch・HEAD・未コミット変更と対象コミットの包含関係を確認し、独自履歴を削除せず統合する。既に反映済みなら重複操作しない。
- 再起動・起動確認の明示許可を確認し、Concordia testing claim/releaseの下でExcubitor経由・Pagus本体のみを使用する。
- sim/serverの実行成果物とクライアントの配信内容が対象変更を含むことを確認する。サーバー変更には必要なビルドと再起動、クライアントには最小の反映方法を選ぶ。
- 前後のコミット、サービスPID、配信確認結果を別の確認記録に残す。住民データの初期化・未追跡資料の上書きを行わない。

## スコープ (編集可ディレクトリ)

Pagus本体へのレビュー済み変更の反映、生成成果物、spec/plan/problem_logs/の確認記録。新機能実装・データ初期化は含めない。
