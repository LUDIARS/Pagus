---
task: pictor-seamless-mobile
project: Pagus
kind: 実装
created: 2026-09-09
memory_links:
  - spec/feature/area-resident-playback.md
---
# Pictor描画・シームレスなエリア読み込み・スマホ操作

## 目的
Pictorを唯一の描画基盤とし、ワールドの連続移動と周辺モデル読み込み、スマホのドラッグ・ピンチに対応する。

## 完了条件
- PixiJSと旧描画コードを除去し、Pictorの固定バージョン配布物を使用する。
- カメラに合わせて近隣エリアを購読し、境界移動で住民を全消去しない。
- 詳細描画の予算を設け、遠方モデルを簡略化・画面外をカリングする。
- 1本指移動、2本指拡縮、キャンセル、終了時イベント解放を扱う。
- 静的検査とビルドを実施し、テスト・起動確認は実施しない。

## スコープ (編集可ディレクトリ)
packages/client/、packages/server/src/area-stream.ts、packages/server/src/ws-server.ts、packages/server/test/、packages/sim/src/index.ts、packages/sim/src/protocol.ts、packages/sim/src/town-areas.ts、packages/sim/src/town-view-limits.ts、packages/sim/test/、spec/feature/、spec/domains/client-ui-pixijs.domain.json、依存lockfile。
