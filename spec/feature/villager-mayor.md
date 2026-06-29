# 村長 (村人の選挙) §17

> 2026-06-30 起草・実装。村長は**村人 (NPC) の 1 体**。選挙イベントで村人世論 (人気度) により就任する。
> 旧「プレイヤーが投票して最多得票プレイヤーが村長」(§v1.3-C ⑥) を置き換える。LLM 非依存の決定的アルゴリズム。

## モデル

`World` 追加: `mayorId: VillagerId | null` / `mayorTermsLeft: number` / `mayorPoll: MayorPoll | null`。
WireWorld に乗って snapshot で配信 (専用メッセージは持たない)。snapshot **v9**。

`MayorPoll` = `{ approval, candidates:[{id,name,support}], dontKnow, hate, noInterest }` (各 0..1)。

## アルゴリズム (`packages/sim/src/mayor.ts`)

- **人気度 `popularity(v)`** (0..1): 優しさ/社交性/規律/野心/喜び で上がり、攻撃性/怒り/狂人/クズ化 で下がる。
  プレイヤーの応援/扇動/推しは、村人の感情・気質を動かすことで**間接的に**ここへ効く (sim は player を直接見ない)。
- **`electMayor(world, cfg, excludeId?)`**: 人気度最大の生存村人を村長にし、`mayorTermsLeft = electionIntervalTerms`、`mayorPoll = null`。
- **`computeMayorPoll(world, cfg)`** (純関数): 生存村人を有権者として各自を
  みんなきらい (攻撃性+怒り > `hateThreshold`) / きょうみない (社交+好奇 < `interestThreshold`) /
  わからない (規律 < `clarityThreshold`) / 支持 に振り分ける。人気候補 = 人気度上位 `topCandidates`。
  支持率 `approval` = 現村長の人気度 ×(1 − みんなきらい率)。
- **`tickMayor(world, cfg)`** (TermMachine が日末 `advanceDay` で呼ぶ):
  - 村長が退場 (死亡/追放) → 即補欠選挙 (`vacancy-elected`)。
  - `mayorTermsLeft` を1減らし、0 で通常選挙 (`elected`)。
  - 残り <= `campaignTerms` (選挙運動期間) は `pollRefreshTerms` ごとに `mayorPoll` を更新。期間外は null。
- **`recallProbability` / `recallMayor(world, rng, cfg)`**: 成功率 = `(1−支持率)×recallApprovalWeight +
  事件度×recallIncidentWeight` (上限 `recallMaxProb`)。事件度 = 村長の `eventParams.incidentExposure + reformCount` を
  `recallIncidentScale` で正規化。`rng() < 成功率` で成立 → 罷免し、罷免者を除いて即補欠選挙。

### 既定値 (`DEFAULT_MAYOR`, ターム基準 = ゲーム内1日)

`electionIntervalTerms`360(≈1年) / `campaignTerms`180(≈半年) / `pollRefreshTerms`15(≈半月≈30分) /
`topCandidates`3 / `hateThreshold`1.1 / `interestThreshold`0.6 / `clarityThreshold`0.35 /
`recallApprovalWeight`0.7 / `recallIncidentWeight`0.5 / `recallIncidentScale`4 / `recallMaxProb`0.9。

## 配線

- sim: `TermMachine` が構築時に初回選挙 (mayor 未設定時)、日末 `advanceDay` で `tickMayor`、`recallMayor()` を公開。
  `AdvanceDayResult.mayor` に選挙イベントを載せて server がログ。
- server: `{t:'recallMayor'}` を受け、請願費 `politics.recallStake`(50) を引いて `tm.recallMayor()`。結果を村の歴史へ。
  旧 `Governance` の村長 (voteMayor/tallyMayor/特典/`broadcastMayor`/`mayorPeriodMs`) は撤去。
- client: 政治パネルが snapshot から 現村長/次の選挙/世論調査 を描画し、リコールボタンを出す。
  旧 `voteMayor`/`mayor` メッセージ・onMayor は撤去。

## 開いた判断 / 今後

- 人気度・世論バケツ・リコール係数は sim 内定数 (`DEFAULT_MAYOR`)。観戦してバランス調整、必要なら暗号化 config 化。
- 「過去の事件」は現状 村長個体の改変回数 + 事件遭遇。村全体の治安や任期中の事件履歴を見るかは要観戦。
- 村長の実権 (特典) は現状なし。法案/しきたり等への村長ボーナスを持たせるかは別途。
