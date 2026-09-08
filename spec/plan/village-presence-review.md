# Pagus 変更の確認記録

対象: feat/village-presence-20260908。ローカル main 784ddab 起点。

## 変更

住民の散歩・対人会話と威圧的な歩行、教育形態に応じた目の描画、詳細な曲面とモデルの1.35倍表示、
放射状道路・環状路・住宅配置・地面の起伏、非公開LLMスイッチによる観戦者への自発的な問いかけ。
新しい非公開判断はサーバーのLLMモジュール内だけに持ち、既存チャットには発言だけを送る。
LLM機能は明示的な llm モードで有効。stub モードでは無効。

## 再利用と境界

Anatomia where/findで townRoute と既存ドメインを確認。TownMap、教育ゲート、BT、CliLlmClient、
ChatStore、CostLog、VillageRenderer を再利用した。道路生成、自由時間の目標・会話、地面高さ、
非公開の観戦者呼びかけは各責務のモジュールに分離した。
Fg の道路沿い敷地と意味的な施設IDの設計を参考に、Pagus既存の住宅IDを保持する。

## 静的確認

- client / server / sim の TypeScript noEmit チェックを実施。
- Anatomia verify の rule_conformance / duplication / spec_linkage / coupling_delta / convention_drift が pass。
- 本体の登録済み project analyze pagus: 192ファイル、1,901関数、93エントリーポイント。
- program domains はレイヤー設定未定義により11モジュールが未分類。16件の既存意味ドメイン宣言と区別する。
- 公開モデルへ非公開スイッチを追加していないこと、shutdownで非同期判断の完了を待つことを差分で確認。

## 未検証

単体・統合・動作・起動テストは実施しない。今回の変更を起動中mainへ反映していない。
実画面でのモデル・起伏・道路の見え方、全住民の経路一巡、LLM呼びかけ・人間の返答、非露出の通信確認、
長時間描画と推論コストは動作未検証。Anatomia pass はこれらの動作保証ではない。

## Pf

Pagus project: 01M20FNTMBJ498ZY1DDSTQJSEG。Anatomia repo: pagus。
初回30資料・278件を基本フラグメントとして登録し、全件を再取得してUTF-8本文を照合した。
4コアは候補として登録、9ビジネス候補は提案フラグメント。既存資料の実装状態はunverified。
元資料の表記の差・将来計画を勝手に現行仕様へ統一せず原文を保存する。
spec/praeforma/import-manifest.json に出典、項目、Pf IDと本文ハッシュを記録。
