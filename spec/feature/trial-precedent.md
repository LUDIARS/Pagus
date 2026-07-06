# 裁判判例 (trial precedent) — 成長型ブラックボックス採用

裁判の性格グループ投票 `groupVoteFate` (kill/spare、strong tier LLM × グループ数/裁判) を
共通ライブラリ **`@ludiars/blackbox`** (LUDIARS/Lapilli、設計正本 `packages/blackbox/DESIGN.md`)
で「判例」ルールに蒸留する。村に判例法が創発し、確立した量刑判断は LLM を卒業する。

## 仕組み

1. 曖昧時 (判例なし)、従来どおり strong LLM がグループ投票する。同じ 1 コールで
   「この量刑が特徴量の閾値で再現できるなら proposedRule に判例を書け」と聞き
   (`prompt-build.buildFatePrompt` の ruleHint)、候補判例を蓄積する。
2. 特徴量 (`fate-blackbox.fateFeatures`): axis (グループ軸) / damage / involvedCount /
   reformCount / madman / scummy / stress / dominantTrait / aggression / kindness。
   **村人 id 等の一過性の値は入れない** (世代を跨いで通用する判例にするため)。
3. 候補判例は発火せず、以後の投票のたびに LLM 判断と影で突合 (影評価)。一致 3 回で
   trial (発火 + レビュー待ち)、`POST /api/blackbox/decisions/:id/verdict` の OK×3 で
   auto = **卒業** (そのパターンの量刑に LLM を呼ばない)。NG×3 で撤回 + 再提案ブロック
   (撤回判例は fate プロンプトに注入)。
4. LLM 判断自体はレビューキューに載せない (`reviewLlmDecisions:false` — ゲームの回転が
   速くキューが溢れるため)。キューは trial 判例の発火分に絞られる。

## 置き場所 / API

- 実装: `server/src/llm/fate-blackbox.ts` (features/検証/組み立て) +
  `llm-brain.ts` の groupVoteFate (`fateBlackbox` オプション、未指定なら従来経路)。
- 永続: `data/runtime/blackbox.json` (world.json と同じ流儀、
  `@ludiars/blackbox/file` の JSON ストア)。
- HTTP (WS と同一ポート相乗り): `GET /api/blackbox/rules` (判例一覧 + 卒業メトリクス =
  ルール被覆率) / `GET /api/blackbox/decisions` (レビュー待ち) / `POST .../:id/verdict`。
- stub モードでは判断は発生しないが、蓄積済み判例の閲覧/レビューは可能。

## 非ゴール / 将来

- foolish 投票 (出力が村人 id = 一過性) は対象外。候補相対の出力表現を作れたら再検討。
- ふるまいの法則 (`sim/behavior-rules.ts`, RuleSmith) は別系統の DSL のまま併存。
  将来 blackbox のライフサイクル (影評価/卒業/撤回) を RuleSmith 側に移植する構想はあり。
- 観戦 UI での判例表示 / レビュー操作は follow-up (現状 HTTP API のみ)。
