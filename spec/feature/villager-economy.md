# 住民経済 (§15) — 貧富・趣味消費・非行・クズ化

> 2026-06-29 起草・実装。住民 (NPC) に所持金を持たせ、貧富の差と、それに応じた行動傾向
> (貧 → 非行、富 → クズ化) を **LLM 非依存の決定的アルゴリズム (ブラックボックスエンジン)** で生む。
> プレイヤーのカルマ経済 (§14.B) とは独立した住民通貨。

## 目的

「シムズを超える」創発の一環として、住民に**経済的な動機**を持たせる。金の有無が事件 (非行)
や人格 (クズ化) に波及し、プレイヤーの介入対象に経済軸を足す。送金 (推し) は住民どうしの
自律行動として残す (プレイヤー→他者の送金 UI は §14.B で廃止済み、別物)。

## データモデル (`Villager` 追加フィールド)

| フィールド | 意味 |
|---|---|
| `wealth: number` | 所持金 (住民通貨)。日末決済で増減。 |
| `hobby: Hobby` | 趣味嗜好。消費の荒さを決める。dominant 気質から factory が割当。 |
| `admireId: VillagerId \| null` | 推し (送金先)。未設定/退場時は決済が選び直す。 |
| `scummy: boolean` | クズ化フラグ。大金で true、富裕線割れで false。 |

`Hobby` = `ascetic`(質素) / `collector`(蒐集) / `social`(社交) / `fashion`(着飾り) / `gourmet`(美食) / `gamble`(賭博)。
消費倍率は質素 0.4 〜 賭博 2.2。dominant 気質 → hobby は決定的 (規律→質素、野心→美食、攻撃→賭博 等)。

snapshot version は v7 (旧 world.json は破棄して新規開始)。

## アルゴリズム (`packages/sim/src/economy.ts`)

`settleEconomy(villagers, rng, cfg=DEFAULT_ECONOMY)` を `TermMachine.settleEconomy()` 越しに
server が日末 (advance フェーズ) で 1 回呼ぶ。生存住民ごとに:

1. **収入**: `dailyIncome`(8) + 規律 × `incomeDisciplineBonus`(8)。勤勉ほど稼ぐ。
2. **趣味消費**: `consumeBase`(10) × hobby 倍率 × (クズ化なら `scumWasteMult`(2))。所持金は 0 未満にしない。
3. **推し送金**: `admireId` が無効なら最富裕傾向 (野心最大) で選び直し。`wealth > sendFloor`(60) かつ
   確率 `sendChance`(0.35) で `(wealth-sendFloor) × sendPortion`(0.15) を送る。自己送金は無し。
4. **クズ化判定**: `wealth >= scumThreshold`(400) で `scummy=true` (遷移を記録)、`wealth < richThreshold`(250) で更生。
5. **たかり**: `scummy` 個体は確率 `demandChance`(0.3) でプレイヤーに `demandBase`(20)+rng×`demandSpread`(30) のカルマを要求。

返り値 `EconomySettlement { transfers, demands, scumChanges }` を server が live feed に出す
(💸 送金 / 🤑🧹 クズ化遷移 / 💢 たかり)。毎日の消費は集計しない (ログ過多回避)。

## 非行・クズ化の事件化連動 (behavior-rules)

経済そのものは数値計算に閉じ、事件化への波及は **behavior-rules の DSL** で表現する
(関心の分離)。`RuleCondition` に `wealthBelow`/`wealthAbove` を追加し、base ルールを 2 本足す:

- `base_poor_delinquency`: `wander` かつ `wealthBelow 40` → `triggerWeight`+2・怒り+0.1。
  → daily-engine の自由行動事件化閾値が下がり、**金欠の個体が非行に走りやすくなる**。
- `base_rich_scum`: `wander` かつ `wealthAbove 400` → `triggerWeight`+1・喜び+0.05。
  → **大金持ちが横柄に振る舞い諍いの火種になる**。

閾値は `DEFAULT_ECONOMY` と base ルールで二重に持つ (一致させること、コメントで明記)。

## 観測 (client)

右パネル「村の経済」に 富裕/貧困 数・クズ化 数・最富裕個体 (名前/所持金/趣味) を表示。
個体の `wealth`/`hobby`/`scummy` は `WireWorld.villagers` に乗って配信される (toWire は Villager 丸ごと)。

## 開いた判断 / 今後

- 経済チューニング値は現状 sim 内定数 (`DEFAULT_ECONOMY`)。観戦して必要なら暗号化 config 化。
- たかり (demand) は現状 live feed 表示のみ。プレイヤーが払う/拒む応答経路はコマンド UI 刷新に合わせて足す。
- アイテム (人手で配置するランダム配布物: 貴金属=富, 薬物=?) は別タスクで wealth/behavior に接続予定。
