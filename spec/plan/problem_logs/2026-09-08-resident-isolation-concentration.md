# 住民全員が隔離施設の入口に集中する

- Date: 2026-09-08
- Status: fixed in working tree
- Area: Pagus backend residency / daily routine
- Severity: 街の生活と建設が停止し、住民が一地点に重なる

## Summary

利用者から「住民が偏っている」と報告。描画だけの問題ではなく、配信中の生存住民全員が同じ隔離先に移動していた。

## Evidence

- 2026-09-08 の canonical サービス WebSocket snapshot を読み取り集計。
- 生存住民156人、housing=isolated が156人、位置(22, 2)が156人。
- 155人の理由は「繰り返される嫌がらせから逃れ、街はずれの離れで暮らしている」。1人は初期設定の迫害の経歴。
- 職業8種類の人数は各19〜20人で、職業割当の偏りではない。
- `term-machine.ts::applyRelationshipEffects` は harass ごとに townHarassment を加算し、累計6以上で隔離する。
- `town-routine.ts::townRoutine` は隔離住民の全覚醒時間を homeId の内職に割り当てる。
- `town-residency.ts::changeHousing` は隔離住民全員の homeId を isolation にする。
- `town-construction.ts` は隔離中の大工を建設から除外する。

## Regression Context

長時間運転で住民状態が隔離へ収束する問題。過去に修正済みだったことは未確認。

## Cause

嫌がらせの累計による隔離に、期間制限・回復・復帰経路がなく、全員が同じ施設入口へ移動する。描画上限30人による切り捨ても重なるが、根本原因はバックエンドの状態遷移。

## Fix Requirements

- 隔離を残す場合の発生条件と解除条件を決める。
- 既存セーブの155人の隔離をどう扱うか、初期の迫害の経歴と区別して決める。
- 住民の意思決定・移動はバックエンドのBTを正本に保つ。
- 再集合・建設停止を防ぐ。セーブの無断初期化や一括書換えは行わない。

## Verification

サービス反映の確認に合わせた読み取り集計で原因を確認。修正後は sim の TypeScript `--noEmit` と `git diff --check` を通過。自動テスト・修正版サービスの起動は未実施。
修正時には反復嫌がらせ、平穏期間、初期隔離住民、セーブ再開、大工の復職を確認する必要がある。

## Follow-up

利用者が「平穏な期間で復帰」を選択。3日間の平穏による回数リセットと復帰、隔離中の日常BTによる休養、旧セーブの待機期間初期化を実装した。サービスへの反映と長期間の実動作確認は別途行う。
