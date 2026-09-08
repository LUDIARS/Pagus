# 住民が小さく粗く見え、隔離が偏る

- Date: 2026-09-09
- Status: fixed in working tree
- Area: village camera / resident meshes / isolation
- Severity: 住民の観察と日常行動を妨げる

## Summary
neco: 「画面引きすぎ」「モデルが適当」「住民の隔離属性を解除。隔離判定を見直す」。
隔離の集中は前日の復帰処理追加後も報告された再発。

## Evidence / Cause
- stage-view.ts: resetCamera の zoom=2.5。表示範囲が広い。
- resident-mesh.ts: 共通胴体と単純な顔に依存し、種族の体形・服の仕立てが乏しい。
- town-residency.ts: 初期住民に隔離を固定割当。
- town-isolation-recovery.ts: 嫌がらせ6件の累積で、恐怖や同一時間帯の重複を問わず隔離。

## Fix Requirements / Implementation
- 初期ズーム4.5、上限8。顔と衣服を見られる距離に寄せる。
- 種族別の体形・顔面・羽毛、襟・前立て・ボタン・袖口・靴を共通モデルへ反映。
- 初期隔離を廃止。policy version 2への一回限りの移行で既存の隔離を解除し、家・職業を保持。
- 解除後3日間は再隔離しない。日内の6つの異なる時間帯での嫌がらせとfear>=0.8をともに必要とする。
- 恐怖条件の追加にあたり、被害者側の恐怖を上げる経路が存在しなかったため `recordTownHarassment` で1回0.14加算する。ふるまいの法則 (`evaluateRules`/`applyEmotionDeltas`) は行動した本人にしか感情差分を与えず、`base_night_prowl` の fear も徘徊した側に付く。この加算が無いと被害者の fear は常に0のままで、恐怖条件が永久に成立せず隔離が到達不能になっていた。
- 3日間平穏なら復帰する既存処理は保持。

## Verification
隔離ロジックは `packages/sim/test/town-isolation-recovery.test.ts` で回帰を張った (恐怖の加算・閾値到達・低恐怖では隔離しないことを含む)。
起動・画面確認は未実施。要目視: 初期画角、種族の識別、clockworkのハイライトなし・hybridの赤目維持、裁判の会話送りとカメラ追従。

## Follow-up
このPRを反映後、既存住民の解除を確認する。稼働中データは本作業では直接書き換えていない。
