# 住民の自律BT版とLLM介入

## 目的と版

住民の行動をLLMの直接出力で決めず、状態と介入入力からビヘイビアツリーで選ぶ比較版。`feat/resident-bt-autonomy` はローカルmainから専用worktreeを作り、前版の3D住民・街・日課の3コミットを取り込んだ。前版 `feat/resident-3d-narrative` は保持し、変更しない。

起動設定 `PAGUS_RESIDENT_CONTROL=bt` がこの版の既定。`legacy` は従来の個体Brain選択を使う。不正値は起動時にエラーにする。既存の `PAGUS_BRAIN=llm` はBT版では神の声チャットの介入解釈だけを有効にし、`stub` ではプレイヤーの発言をローカル分類する。既存サービスの設定変更や起動はこの作業で行わない。

## 行動の決定境界

`behavior-tree.ts` は condition / action leaf / sequence / reactive selector と success / failure / running を実装する。外部I/Oを持たず同期評価する。runningは次tickでrootから再評価するため、日課の時刻変更や教育の割り込みを妨げない。最終移動先までの経路は従来どおりサーバーが保持する。

| 対象 | BTの責務 | 実装 |
|---|---|---|
| 日常・休息・対人行動 | 睡眠、受諾した鎮静、既存学習ルールと関係行動を選択 | resident-daily-tree.ts / DailyEngine |
| 移動目的 | 休息・隔離、教育ケア、教育調査、規律、受諾介入、収集、時刻表の順で評価 | resident-goals.ts |
| 最終出力 | 教育ゲートの通過後、通行可能な経路を選び、到着まではrunningを記録 | resident-goals.ts |
| 事件への反応 | 教育による自制、助けを求める、口論、見聞きの説明 | resident-bt-brain.ts |
| 投票・教育 | 個々の住民の判断を既存blocに集計、人格に応じた教育方向・差分を選ぶ | resident-trial-tree.ts |
| 裁判の発言・人間への応答 | 慎重さ、共感、責任追及などを分岐で選ぶ | resident-speech-tree.ts |
| 扇動・罪の押し付け | 特殊な追加票にも教育による自制を適用 | resident-trial-tree.ts / TermMachine |

既存の結婚・出生・所持金決済・カレンダー・投票集計などの世界ルールは引き続きプログラムで状態を更新する。これらをLLMへ移さない。日常の学習済みBehaviorRuleはBTの行動leafで引き続き評価する。性格や記憶に基づく投票は誤りうる意見であり、真犯人の内部idや混合外見を真相判定に使わない。

## LLMは介入入力

神の声チャットへの明示的な投稿時だけ、任意のLLMが `calm` / `investigate` / `gather` の閉じたintentを提案する。LLMは住民の台詞・座標・票・教育差分・実行コードを返せない。形式外の出力はエラーとし、別の行動へ無言で切り替えない。

`offerIntervention` が住民のBTで受諾／拒否を決める。休眠・退場・神隠し・既存提案・隔離・規律の条件を先に判定する。受諾しても2セグメントで失効し、教育割り込みと帰宅・休息を越えられない。同時解析は1件まで。応答待ちに2セグメント以上進んだ提案は適用しない。LLM呼び出しはゲームループからawaitしないため、停止や失敗で街のtickが止まらない。

`BtGodChatResponder` は提案を解釈するserver境界だけを担当し、実際の住民応答はsimのBTで作る。解析失敗は既存の神の声チャットのエラーログへ報告され、介入は追加されない。用途別コストへ介入解析を記録する。

## 自動LLM呼び出しの除去

BT版では `ResidentBtBrain` と `AutonomousWorldBrain` を明示選択する。個体・世界LLMを代替stubとして選んでいるのではなく、この版の正規のローカル実装である。事件設計と日末の評判はカレンダーと判決に基づく規則で進む。物語の予兆・事件・裁判・余韻は前版のナラティブディレクターを継続する。

日常shadow sampling、日末自動蒸留、自動ルール増殖、裁判台詞LLM、日末／裁判要約LLMはBT版では起動しない。既に保存されている蒸留済みルールは残す。新しい汎用ルールや未知のBTノードをLLMが作る機能は今回の介入契約に含めない。

## 可視化・保存

World/WireWorldに `residentControl`、Villagerに直近8回の `btHistory` と任意の `btIntervention` を保存する。既存snapshotへ追加可能な任意フィールドとしてバージョン11を維持。起動時の選択が保存されたmodeより優先する。住民詳細に選ばれたノードと判断を表示し、行動方式を「BT自律・LLMは介入」と示す。

## 確認

sim/client/serverのTypeScript静的チェックとdiffの確認を実施。ユーザー指示に従い単体・統合・起動テスト、サービス再起動は行わない。LLM停止時の実時間進行・介入の配送・裁判一巡・保存復元の実動作は未検証。PR提出後停止し、マージ・main更新は行わない。
