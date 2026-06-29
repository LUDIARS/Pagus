# 多人数ソーシャル機能 (v1.2) — 応援 / 村いじり / 裁判ベット / 称号・陣営

> 2026-06-28 起草。ユーザ採択 (推し指名+弔い / しきたり改定 / 裁判ベット / 称号・陣営) を正本化。
> 既存資産 (カルマ/善性=`server/player-state.ts`、村のルール=`world.villageRules`、BehaviorRule=`sim/behavior-rules.ts`、裁判=`TermMachine`) の上に**毎 tick LLM を増やさず**乗せる。
> 数値は env 可変・観戦調整前提。

## 0. 方針

- 状態は基本 **server (per-userId)**。sim には最小限のフック (推しの死の検知・村ルール編集・ベット決済の節目) だけ足す。
- 接続↔userId は既存 (`hello` + ws-server の `connUser`)。per-connection 送信 (`sendToUser`) も既存。
- 全機能 LLM 不使用 (弔いの legacy ルールはテンプレ生成、必要なら別途 Haiku に委ねる余地あり)。

## 1. 推し指名 (champion) + 弔い (legacy)

### 1.1 推し指名
- `ClientMessage` `{ t:'champion'; targetId; userId? }` — その userId の **推し**を 1 体指定 (再送で差し替え、自分自身の前推しは解除)。
- `PlayerEntry.championId: VillagerId | null` を追加。
- **推しが生存中はカルマ加速**: `accrue` の加算に推し生存なら `× PAGUS_CHAMPION_KARMA_MULT`(既定1.5)。
- `playerState` に `championId` / `championName` を載せて返す。

### 1.2 弔い (legacy)
- server は snapshot ごとに「前回生存 → 今回 `alive=false`」になった villager を検知する (死亡検知)。
- 死んだ villager を**推しにしていたユーザ**へ: カルマ `-PAGUS_CHAMPION_DEATH_PENALTY`(既定20)、`championId` を null に。`commandRejected` ではなく専用ログ/通知。
- **弔い = legacy 痕跡**: 死んだ villager に推しがいた場合、村に追悼の `VillageRule` を 1 つ自動追加する (例: 「`<name>` の名をみだりに口にしてはならない」)。`world.villageRules` 上限内。chronicle に `🕯 弔い: <name> を悼む掟が生まれた` (kind:'rule')。
  - これにより死が村の**しきたり (= 次の事件の火種)** として残り続ける。
- 推しがいない villager の死は弔い無し (通常の追放/処刑ログのみ)。

## 2. しきたり改定 (村のルール編集)

- `{ t:'addRule'; text; userId? }` / `{ t:'removeRule'; ruleId; userId? }` — カルマを払って `world.villageRules` を増減。
- コスト: `PAGUS_RULE_ADD_COST`(15) / `PAGUS_RULE_REMOVE_COST`(25)。上限 `PAGUS_VILLAGE_RULES_MAX`(12)。
- text は長さ検証 (1..40 文字)・トリム。追加ルールは `id` を採番。
- 追加/削除した村のルールは**次月の事件デザイン (`designIncident`) の入力**に既に流れる → プレイヤーが火種を書く。
- chronicle に `�filterメモ` 不要、`📜 しきたり: 「…」が定められた/廃された` (kind:'rule')。村のルールは snapshot で配信済 → client 履歴の「村のルール」タブに反映。
- sim 側: `world.villageRules` の add/remove ヘルパを `world.ts` か `village-rules.ts` に置く (id 採番含む)。server から呼ぶ。

## 3. 裁判ベット (trial betting)

- 裁判の **fate 段階**が開いている間、ユーザは結果に賭けられる: `{ t:'bet'; pick:'death'|'educate'; amount; userId? }`。
  - `amount` は `PAGUS_BET_MIN`(1)..保有カルマ。賭けた分は即 hold (カルマから引く)。同段階で増額のみ可 (減額/取消なし、観戦は単純に)。
- server に **BetPool** (現裁判 incidentId ごと): `{ death: Map<userId,amount>; educate: Map<userId,amount> }`。
- **決済**: 判決確定 (verdict death/spared(=教育)) 時、**パリミュチュエル**で清算。
  - 勝ち側の各ユーザに `自分の賭け金 + 負け側総額 × (自分の賭け金 / 勝ち側総額)` を払い戻す (按分)。
  - 片側が空なら全額返金 (不成立)。端数はプール残として捨てるか勝者最大へ。
- verdict 確定の検知: server が phase→ketsu / trial.verdict 確定を snapshot から検知して 1 回だけ清算 (incidentId で多重清算防止)。
- `ServerMessage` `{ t:'betState'; incidentId; pool:{death:number;educate:number}; yourBet:{pick;amount}|null }` を per-connection + プール総額は broadcast。決済結果は playerState 更新 + ログ。

## 4. 称号 / 実績 + 二大陣営

### 4.1 実績カウンタ
- `PlayerEntry.stats: { incites; sanctions; cheers; rulesAdded; betsWon; championDeaths }` をインクリメント。

### 4.2 称号 (titles)
- 称号は**プレイヤー間の最大保持者**に与える動的タイトル (同点は userId 昇順):
  - `破壊神` = incites 最多 / `審判者` = sanctions 最多 / `聖人` = cheers 最多 / `立法者` = rulesAdded 最多 / `博徒` = betsWon 最多。
- 0 件の項目は称号を出さない。各ユーザの主称号は最も尖った項目で 1 つ選ぶ。

### 4.3 二大陣営 (善導 vs 扇動)
- `{ t:'faction'; side:'guide'|'incite'; userId? }` で選択 (未選択は行動から推定: cheers+educate寄り→guide / incites+sanctions寄り→incite)。
- **シーズンスコア = 村の徳目の綱引き**: 善導陣営は村の `benevolence+order`、扇動陣営は `malice` を「自陣の旗色」として可視化。陣営ごとの貢献 (guide=cheer/教育票, incite=扇動/制裁/死刑票) を集計しスコア化。
- `ServerMessage` `{ t:'leaderboard'; players: LeaderboardEntry[]; factions:{ guide:number; incite:number } }` を broadcast。`LeaderboardEntry = { userId; title:string|null; faction:'guide'|'incite'; karma; virtue; stats }`。
- client: プレイヤー欄に称号・陣営・スコアボードを表示。

## 5. 実装フェーズ

- **v1.2-A**: §1 推し指名+弔い + §2 しきたり改定 (PlayerState.championId / 死亡検知 / 村ルール編集)。
- **v1.2-B**: §3 裁判ベット + §4 称号・陣営 (BetPool 決済 / stats / titles / faction / leaderboard)。

## 6. env 既定 (観戦調整)

`PAGUS_CHAMPION_KARMA_MULT`=1.5 / `PAGUS_CHAMPION_DEATH_PENALTY`=20 / `PAGUS_RULE_ADD_COST`=15 / `PAGUS_RULE_REMOVE_COST`=25 / `PAGUS_VILLAGE_RULES_MAX`=12 / `PAGUS_BET_MIN`=1。

## 8. 追加ソーシャル案バックログ (v1.3+ 候補)

> 2026-06-28 追加。採択待ちの案。すべて既存資産の上に**毎 tick LLM を増やさず**乗る前提。

**経済/取引**: ①カルマ送金(投げ銭/賄賂) — **廃止** (2026-06、人から人への送金は実装しない) ②カルマ市場(称号/バフのオークション) ③推し保険(死亡で配当) ④銀行(預けて利子) — **廃止** (2026-06、預金は実装しない) ⑤闇市(天災/復活など強力カードをカルマ購入)。
**集団/政治**: ⑥村長 — **2026-06 刷新**: 村人が選挙で就任 (世論調査+リコール、§17)。旧プレイヤー村長は廃止 ⑦法案投票(ルール追加を多人数投票・可決で割引) ⑧革命(悪辣閾値超で蜂起、煽動/鎮圧分岐) ⑨戒厳令(カルマ集約で事件凍結/多発を切替) ⑩税(全員から徴収し村基金へ)。
**関係/感情**: ⑪縁結び/破談(結婚を後押し/妨害) ⑫弟子入り(推しの性格が弟子へ伝播) ⑬因縁(2住民にライバル関係→事件率UP) ⑭推し継承(死んだら子/弟子を次の推しに) ⑮感情伝染(1体の感情を群へ波及)。
**介入/いたずら**: ⑯天災カード(干ばつ/嵐/疫病=一時 BehaviorRule) ⑰神隠し(住民を一時退避=裁判逃れ) ⑱入れ替え(2住民の性格/姿スワップ) ⑲覚醒(隠し気質を解放) ⑳偽予言(来月事件の偽情報で村をざわつかせる)。
**観戦/演出**: ㉑ハイライトカード(処刑/和解の名場面を共有) ㉒弾幕実況(プレイヤーチャットが村上空に流れる装飾) ㉓予測アワード(事件発生日を当ててカルマ) ㉔月間MVP住民投票(称号付与) ㉕観客の祈り(同時多発でみんなにバフ=協力)。
**永続/レガシー**: ㉖殿堂入り(伝説の住民を記録、新村に子孫登場) ㉗年代記編纂(歴史に見出し/注釈) ㉘石碑(カルマで永続テキストを刻む)。
**協力/対戦**: ㉙共闘レイド(凶悪な連続犯をプレイヤー総出で裁く協力戦) ㉚シーズン制(月末に陣営勝敗確定→称号/報酬リセット+ランキング保存)。

## 7. 開いた判断

- 弔いの legacy ルール文面: テンプレ固定 (既定) か Haiku 起案か (将来)。
- ベットの不成立端数の扱い (捨て or 繰越)。暫定 = 捨て。
- 陣営スコアのシーズン境界 (月 or 任意リセット)。暫定 = 累積 (リセットなし、UI で現状値)。
- 称号のしきい値型 (○件以上) vs 最大保持者型。暫定 = 最大保持者型。
</content>
