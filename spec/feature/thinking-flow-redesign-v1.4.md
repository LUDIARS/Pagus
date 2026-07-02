# 住民思考・ゲームフロー レビュー & v1.4 実装設計 — 蒸留ループ / 事件アーク / 即効介入 / 善良テーマ

> 2026-07-02 起草。ユーザ提示の 4 論点 (①住民の思考 ②進行の単調さ ③介入の短期性 ④カルトオブラム層×善良ゲーム) のレビューと、その回収実装の設計。
> 現状把握は SPEC.md §12 (コスト削減) / §8B (創発) / `packages/sim/src/{daily-engine,behavior-rules,term-machine}.ts` の実装読解に基づく。
> 数値は当て推量で観戦調整前提 (暗号化 config `pagus.config.json` の dotkey、§6)。

## 0. レビューサマリ

| 論点 | 現状評価 | 結論 |
|---|---|---|
| ① 住民の思考 | 「LLM→ブラックボックス乗せ換え」は **v1.0 で一度完了済み** (日常 LLM 全廃 = `DailyEngine` + `BehaviorRule`)。ただし置換が一方通行で、LLM の思考の質がエンジン側へ還元される経路が RuleSmith のアトランダム生成しかない | 乗せ換えを一回きりの移植でなく**常時運転の蒸留ループ** (LLM=教師 → ルール=生徒) にする (§1) |
| ② 進行の単調さ | 事件は 月1 designed + organic + 制裁 の 3 経路だが、どれも「事件→裁判→教育」の 1 話完結。継続性は連続犯 (scapegoat) のみ | 事件の結末が**火種 (PlotThread)** を残し、派生表 (IncidentArc) で次の事件に繋がるデータ駆動グラフ + 大事件の間を埋める**小騒動** (§2) |
| ③ 介入の短期性 | 既存 20 操作を「即時に見える×環境に残る」2 軸で棚卸しすると、**即時×残留のセルがほぼ空** (制裁とカード数枚のみ)。長期投資系 (推し/保険/法案/しきたり) に偏り | 「3 秒で見えるリアクション + 残留タグ」を介入の必須 2 点セットと定め、即時×撹乱の新介入 5 種を足す (§3) |
| ④ CotL層×善良 | かわいい×ダークのギャップ・教義カスタム・住民観察・儀式演出という CotL の魅力 4 要素のうち、Pagus は後ろ 3 つを既に持つ。ダーク表現は語彙/演出層に集中しており sim には染みていない | **語彙/演出をテーマパック (LexiconPack) としてデータ分離** + ダーク度を config で振る**モラルダイヤル**。GTA→Roblox 型 = 基盤共通・プレゼン差し替え (§4) |

---

## 1. 論点① 住民の思考 — LLM 教師 → ブラックボックス生徒の「蒸留ループ」

### 1.1 現状評価

- 日常の意思決定は `DailyEngine.decide` (`packages/sim/src/daily-engine.ts`) が LLM 非依存で行い、感情も `behavior-rules.ts` の `evaluateRules` の決定的評価。LLM が本当に思考するのは 承 (当事者応答) / 転 (裁判) / 結 (教育) / 世界評価のみ。**「最初 LLM → ブラックボックスへ」の乗せ換え自体は完了している。**
- 問題は乗せ換え後の**質の固定化**:
  1. `RuleSmith` (`term-machine.ts` `maybeGrowRule`) は日末に低確率で「アトランダム」にルールを 1 本足すだけ。村で実際に起きたことと無関係なルールが増える。
  2. `BehaviorRule` DSL の表現力が感情 delta / triggerWeight / actionFlavor どまりで、「情報 (InfoItem) を読む」「関係を読む」「情報を撒く」ふるまいを書けない。LLM がどれだけ良い思考をしても、この DSL に落ちない知見は回収不能。
  3. 生成ルールの良し悪しを測る仕組みがない (追加されたら `PAGUS_RULES_MAX` で古い順に間引くだけ)。

### 1.2 提案 — 蒸留ループ (Teacher–Student distillation)

「LLM で思考させて → エンジンに乗せ換える」を**継続プロセス**として機構化する。

```
日常 tick (DailyEngine, LLM 0円)
   │ 低頻度サンプリング (例: 1 日 1〜3 tick 分)
   ▼
Shadow 呼び出し: 同じ ActionContext を教師 LLM (Haiku) にも渡す
   │ 生徒 (DailyEngine の決定) と比較
   ▼
乖離ログ (DivergenceLog): カテゴリ/事件化判断/感情方向が食い違ったケースを蓄積
   │ 日末、乖離ケースが閾値を超えたら
   ▼
RuleSmith 蒸留モード: 乖離ケース束を Haiku に渡し「これを説明する BehaviorRule」を起案
   │ 閉じた DSL に coerce (既存 json-coerce)
   ▼
Shadow replay ゲート: 過去の乖離ケースに新ルールを再適用し、教師との一致率が
   改善するときだけ採用 (決定的・LLM 不使用)
```

- **日常 tick は今後も LLM 0 円のまま**。増える LLM 費は shadow サンプル (cheap/Haiku、日数回) と蒸留起案 (日末最大 1 回) だけで、§12 のコスト方針と両立する。
- 既存の「アトランダム生成」は残してよい (探索)。蒸留は「搾取」側で、両輪になる。

### 1.3 実装設計

#### (a) DSL 拡張 — BehaviorRule v2 (`packages/sim/src/behavior-rules.ts`)

蒸留の受け皿を先に広げる (表現力が足りないと教師の知見が落とせない)。すべて enum + switch の閉じた評価のまま:

- **when 追加**: `infoContains {substr}` (InfoItem 本文の部分一致) / `infoFromPlayer` (source:'player' の情報を持つ) / `stressAbove` / `emotionBelow` / `relationTo {kind}` (進行中の関係性実装 §8 と接続) / `placeState {state}` (§3.4 の場所状態)。
- **then 追加**: `spreadInfo` (自分の InfoItem を近傍 1 体へ複製 = **噂の自然伝播**) / `moveBias {towards:'partner'|'admire'|'away-madman'}` (移動の重み付け) / `wealthDelta`。
- `RULE_DSL_VERSION` を持ち、coerce (`server/src/llm/json-coerce.ts`) は未知 op を **reject** (無言フォールバック禁止の維持)。

#### (b) Shadow サンプラ (`packages/server/src/distill/shadow-sampler.ts` 新設)

- `TermLoop.tick` の kisho 分岐で、config `distill.sampleChance` (既定 0.02) を引いたら、その tick の `ActionContext` 相当 (環境/感情/情報/直近ルール適用結果) を**コピーして** teacher へ非同期投げ (`fire-and-forget`、sim 進行はブロックしない)。
- teacher = cheap tier (Haiku)。プロンプトは `prompt-build.ts` に `shadowAction` を追加、出力は `ActionDecision` 互換 JSON。
- 生徒決定 (実際に採用された `DailyDecision`) と teacher 出力を `DivergenceLog` (`data/runtime/divergence.jsonl`) に対で append。比較キー: `actionCategory` / `triggersIncident` / 感情主軸の符号。

#### (c) RuleSmith 蒸留モード (`packages/server/src/llm/llm-world-brain.ts` 拡張)

- 日末 `maybeGrowRule` の前段に: 乖離ケースが `distill.minCases` (既定 5) 件たまっていたら、直近ケース束 (最大 10 件) を Haiku へ渡し「乖離を減らす BehaviorRule を 1 本」起案させる (`source:'distill'` を `BehaviorRule.source` に追加)。
- **Shadow replay ゲート** (`packages/sim/src/rule-replay.ts` 新設、純関数): ログ済み乖離ケースへ新ルールを含む rule set を再評価し、教師一致率が `distill.acceptGain` (既定 +10%) 以上改善したら採用。改善しなければ棄却しログに残す。sim 側は決定的なのでテスト可能。
- 採用ルールは chronicle に `🧠 ふるまいの蒸留: <description>` で出す (観戦者に「村が学習した」ことが見える = ①の見せ場)。

#### (d) 事件当事者の思考は LLM のまま維持

承の当事者応答 (Di 方式) と裁判・教育は引き続き LLM。ここは「個別対応の面白さ」が価値でありブラックボックス化しない。**二層脳 (日常=生徒 / 山場=教師) が Pagus の思考アーキテクチャの確定形**、と SPEC §3.1 の三分に追記する (感情=AI → 感情=蒸留されたプログラム、の建付け改訂)。

### 1.4 代替案の 4 軸評価

| 案 | AI 学習量 | 作業コスト | 目的達成度 | 主目的一致 |
|---|---|---|---|---|
| 現状維持 (アトランダム生成のみ) | 低 (村の実態と無関係) | 0 | 低 — 質が固定化 | △ |
| 日常を LLM に戻す | 高 | 低 (revert) | 高いが**コスト青天井** (v1.0 の否定) | ✗ |
| **蒸留ループ (採用)** | **高 (乖離=教師データ)** | 中 (新規 ~4 ファイル + DSL 拡張) | 高 — 質が上がり続けて費用は微増 | **◎ 「AI ループの反復速度」の主目的そのもの** |

---

## 2. 論点② ゲーム進行 — 事件アーク (派生グラフ) と小騒動

> **v1.4-B 実装済 (2026-07-02)**。実装マップ: PlotThread = `sim/plot-threads.ts` + `World.plotThreads`
> (生成点: 判決 (冤罪/遺恨/更生/偽証) = `term-machine.spawnVerdictThreads` / 和解 / 偽予言 / 小騒動の遺恨 /
> しきたり追加・推しの死 = server hook)、派生表 = `sim/incident-arc.ts` + `data/incident-arcs.json`
> (月初 `scheduleMonthlyIncident` が arcHint として LLM/stub へ注入、決着で火種回収)、
> 小騒動 = `sim/minor-incident.ts` (扇動由来はバイパスしフル事件へ直行)、
> 裁判バリエーション = `sim/trial-composer.ts` (witness=目撃者票 / reveal=真犯人発覚の被告差し替え)。
> 観測 = 右パネル「火種」一覧 + live feed (🧵/👁/🔦/〽)。
> **連座 (被告2体) は見送り**: TrialState.defendant 単数の破壊的変更を伴うため、需要を観戦で確かめてから (§9)。

### 2.1 現状評価 — 単調さの根因

1. **1 話完結**: designed 事件 (`scheduleMonthlyIncident` → `designIncident` → `fireScheduledIncident`) は裁判で必ず精算され、翌月の入力に渡るのは連続犯の生存だけ。「前の事件があの結末だったから今度はこうなる」という因果の見え方がない。
2. **頻度の谷**: 大事件は月 1 (実 1 時間 1 回)。間は日常のうろつき + 雑談で、観戦の山がない。organic 事件はストレス耐性で自然収束する設計 (§8B.5) なので、むしろ間延びする。
3. **裁判が毎回同型**: foolish → fate の 2 段 + 糾弾セリフ。3 回見たら形を覚える。

### 2.2 提案 — PlotThread + IncidentArc + 小騒動

**構造は決定的 (データ駆動)、肉付けだけ LLM** の建付けを守ったまま、事件を「点」から「線」にする。

#### PlotThread (火種) — 事件の結末が残す持ち越し状態

```ts
interface PlotThread {
  id: string;
  kind: 'grudge'        // 遺恨: 冤罪死・推し処刑の関係者が恨む
      | 'unresolved'    // 未解決: 真犯人生存 (既存の連続犯を統合)
      | 'redemption'    // 更生: 教育された者の再犯/模範の分岐持ち
      | 'rumor'         // 亡霊の噂/偽予言の後日談
      | 'ruleViolation';// しきたり違反の目撃 (villageRules と接続)
  actors: VillagerId[];        // 退場者は name 文字列で保持 (亡霊参照)
  heat: number;                // 0..1。日末に減衰、関連イベントで加熱
  bornTerm: number;
  note: string;                // LLM/テンプレが読む 1 行文脈
}
```

- `world.plotThreads: PlotThread[]` (上限 `arc.threadsMax` 既定 8、heat 最小を捨てる)。snapshot version +1。
- **生成点** (すべて既存コードにフック): 判決確定 (`ketsuStep`) / 和解 (`shoStep`) / 冤罪 (framed 票で有罪) / 推し死 (弔い §13.1) / 偽予言カード / しきたり追加。

#### IncidentArc 派生表 (`data/incident-arcs.json`, データ駆動)

```json
{ "when": { "threadKind": "grudge", "heatAbove": 0.5, "reputation": { "malice": ">0.4" } },
  "themes": [ { "seed": "復讐", "weight": 3 }, { "seed": "決闘の申し込み", "weight": 1 } ] }
```

- 月初 `scheduleMonthlyIncident` の**前段**に決定的セレクタ `pickArcTheme(world)` (`packages/sim/src/incident-arc.ts` 新設) を置き、plotThreads×村状態から themeSeed 候補と当事者候補を選ぶ。**LLM には「この thread を拾ってこの seed で詳細化せよ」と渡す** (現行の自由生成より入力が濃くなるだけで、呼び出し回数は不変 = コスト増ゼロ)。
- 該当 thread が無ければ従来どおり自由テーマ (フォールバックではなく仕様上の既定分岐)。

#### 小騒動 (minor incident) — 大事件の谷を埋める LLM 0 円の山

- organic 事件化のうち被害が小さいもの (`damage < minor 閾値`) を**簡易決着パス**に流す: 裁判なし、当事者 2〜3 体の寸劇 (テンプレ文 + 気質差し込み、`repertoire.ts` と同型のプールを再利用) → 和解 or 遺恨 thread 化で 2〜3 ステップ終了。
- 週 (ゲーム内 7 日) 2〜3 回を目安に `arc.minorChance` で調整。**小騒動が thread を温め、月次大事件が回収する**リズムを作る。

#### 裁判バリエーション (TrialStage のデータ駆動化)

- `TrialState.stages: TrialStage[]` を固定 2 段から**構成可能列**へ: `witness` (目撃者 1〜2 体が証言。Haiku 生成 65%/レパートリー 35% の既存 `trial-narrator` 機構を流用) / `reveal` (unresolved thread があれば真犯人発覚の逆転イベント、被告差し替え) / 連座 (被告 2 体、fate を 2 回)。
- どの構成になるかは事件の origin/thread から決定的に選ぶ (`trial-composer.ts` 新設)。LLM 追加はゼロ〜witness 分の cheap のみ。

### 2.3 4 軸評価

| 案 | AI 学習量 | 作業コスト | 目的達成度 | 主目的一致 |
|---|---|---|---|---|
| LLM に「毎回違う事件を」と頼むだけ | 低 | 最小 | 低 — 文面が変わるだけで構造は単調のまま | △ |
| **PlotThread+Arc+小騒動 (採用)** | 中 (arc 表そのものが調整可能な学習面) | 中〜大 (sim 新設 2 ファイル + term-machine フック) | **高 — 因果の線・頻度の山・裁判の型崩しを同時に回収** | ◎ |
| フルストーリーエンジン (クエスト木) | 高 | 大 | 高いが観戦ゲームには過剰 | △ |

---

## 3. 論点③ ユーザ介入 — 「即時に見える × 環境に爪痕」を埋める

> **v1.4-A 実装済 (2026-07-02)**。実装マップ: 野次/証言/贈り物 = `packages/sim/src/interventions.ts` +
> `term-machine.ts` (`heckle`/`testify`/`giveGift`)、アイテム即時回収 = `items.ts` (`stepItemPickups`) +
> `server/term-loop.ts` (kisho tick)、コスト/クールダウン = `server/player-state.ts` + config `intervene.*`、
> UI = `client/src/{heckle-buttons,testify-panel,player-controls}.ts` + `stage-view.ts` (リアクション)。
> 証言記録 = `TrialState.testimonies` (v1.4-B の遺恨 thread 生成点)。
> **v1.4-A' 実装済 (2026-07-02)**: spot (場所荒らし/清め) = `World.placeStates` + `interventions.setPlaceState` +
> DSL `placeState` 条件 + base ルール (base_defiled_place / base_blessed_place、復元 world へは TermMachine が補完マージ)、
> fanFlames (噂の増幅) = `interventions.fanFlames` (近傍へ InfoItem 複製 + REACTION_EXPOSURE)。
> UI = アイテムパネルの「🗺 場所」+ 行動ドック「📢 言いふらす」、マップに 💀/✨ マーカー。

### 3.1 現状マトリクス (棚卸し)

| | **残留効果 小** | **残留効果 大 (環境を荒らす)** |
|---|---|---|
| **即時に見える** | cheer(+0.1 は見えにくい) / vote / pray | **制裁 / 神隠し / 入替 ← ここが薄い** |
| **効果が遅い** | ベット / 予測 / MVP | 扇動(翌日以降) / しきたり / 法案 / 天災 / アイテム(日末拾得) / 推し / 保険 / 革命 / 税 |

長期投資系が圧倒的に厚く、**「押した瞬間に村が反応し、しかもその爪痕が残る」操作が制裁 (カルマ高) しかない**。①の指摘どおり。

### 3.2 設計原則 — 介入 2 点セットの必須化

以後の介入 (既存改修含む) は次の 2 点を必ず備える:

1. **即時リアクション (3 秒以内)**: ステージ上の吹き出し/演出 (`StageView.reactToAction` 拡張) + live feed 1 行 + 数値の見える変化。
2. **残留タグ**: `eventParams` 加算 / `PlotThread` 生成 / `PlaceState` (後述) のいずれかを残し、日常エンジン・事件デザインの入力に流れる。

### 3.3 新介入 5 種 (すべて LLM 追加ゼロ〜cheap 1 回)

| 操作 | 即時効果 (見える) | 残留効果 (荒らす) | コスト目安 |
|---|---|---|---|
| **野次 (heckle)** `{t:'heckle', side:'agitate'\|'soothe'}` — 承 (GANs) 進行中限定 | 次の `advanceIncident` 入力に「観客の野次」を注入 → damage/和解確率が即動く。群衆ざわめき演出 | 当事者の `eventParams.heckled` 加算 → 後日の behavior-rule 火種 | カルマ 3、連打 10 秒 CD |
| **証言の投げ込み (testify)** `{t:'testify', stance:'accuse'\|'defend', text?}` — 裁判中限定 | その場の bloc 投票に**1 グループ分の重み**を上乗せ。証言吹き出しが法廷に出る | 偽証 (accuse が無罪側実態と乖離) なら判決後に `grudge`/`unresolved` thread を生成 = **冤罪アークの火種** | カルマ 8 |
| **贈り物/毒饅頭 (gift)** `{t:'gift', targetId, kind:'treat'\|'poison'}` — 既存アイテム (§16) の**即時手渡し版** | その場で wealth/怒りが動き、対象が即リアクション (「!」吹き出し) | poison は `eventParams.drug` 加算 (既存 `base_drugged` ルールに接続) → 数日荒れる | treat 5 / poison 15 |
| **場所を荒らす/清める (defileSpot / blessSpot)** `{t:'spot', place, mode}` | その場にいる住民全員に即時感情 delta + マップに視覚状態 (💀/✨) | **`world.placeStates: Record<Place, PlaceState>` 新設** (TTL 数日)。BehaviorRule の `placeState` 条件 (§1.3a) に効く = **環境そのものを汚す**。「環境=プログラム」の三分と整合する唯一の環境直撃介入 | 20 |
| **噂の増幅 (fanFlames)** `{t:'fanFlames', rumorId}` — 既存 incite で注入した噂を対象の隣人へ伝播 | 伝播先が一斉にざわつく吹き出し | InfoItem が複数個体に残り、`spreadInfo` (§1.3a) で自然増殖 | 10 |

- 実装位置: sim 側 `term-machine.ts` に `heckle`/`testify`/`gift`/`setPlaceState`/`fanFlames` を追加 (各 20〜60 行)、protocol `ClientMessage` 5 種、server `index.ts` ハンドラ + カルマ検証 (`player-state.ts` 既存 spend 経路)、client は行動ドック (`player-controls.ts`) と裁判パネルへ。
- **既存操作の即時化改修**: cheer の +0.1 を「その場でジャンプ+ハート演出 + 気質バーのハイライト」で可視化 / アイテム拾得を「最寄りが数セグメント以内に取りに歩く」(日末一括をやめる) — 数値は据え置きで**体感だけ即時化**。

### 3.4 優先順位 (4 軸)

作業コスト小×達成度大の順: **heckle → testify → gift → 既存 cheer/アイテム即時化 → spot → fanFlames**。heckle/testify は承・転の観戦が「見ているだけ」から「介入で流れが変わる」に変わる本丸で、v1.4-A の先頭に置く。

---

## 4. 論点④ カルトオブラム層ターゲット × 善良ゲーム — テーマパックとモラルダイヤル

### 4.1 分析 — CotL の魅力の分解と Pagus の対応物

| CotL の魅力 | 本質 | Pagus の対応物 | 状態 |
|---|---|---|---|
| かわいい×ダークのギャップ | **トーンの落差**であって残酷さ自体ではない | どうぶつ (Kenney) × 処刑/断末魔 | 語彙・演出層に集中 |
| 教義カスタム (Doctrine) | 自分のルールで共同体を作り替える全能感 | しきたり改定 / 法案 / BehaviorRule | **既にある (強み)** |
| 信者の生活観察 | 自律する小さい人格への愛着 | 日常エンジン / 推し / 結婚出産 | 既にある |
| 儀式の演出 | 定期的な様式美イベント | 裁判劇場 / 断末魔 / 祈り / 祝祭 | 既にある |

→ **ダーク表現を落としても、落差 (ギャップ) と全能感が残れば CotL 層に刺さる**。「GTA→Roblox」の要諦は、基盤メカニクス (物理/経済/自由度) を保ってプレゼンテーションと文脈を差し替えたこと。Pagus の sim はすでに描画/語彙と分離されているので、この改修は構造的に安い。

### 4.2 改修パターン

- **A. テーマパック (LexiconPack) — 語彙/演出のデータ分離**: ハードコードされた文言 (糾弾/断末魔/chronicle 絵文字/事件名/UI ラベル) を `data/theme/<pack>/lexicon.json` に externalize し、server/client が pack 参照で引く。sim は不変。既定 pack `classic` = 現行文言の逃し先。
- **B. モラルダイヤル — config によるダーク度**: `theme.moral` = `dark | balanced | wholesome`。wholesome では: 死刑無効 (`fate` は教育 1 択、死刑ボタン非表示) / 追放→「旅立ち」(名前は殿堂へ) / 狂人→「いたずら妖精」(扇動は維持、文言のみ変更) / 毒饅頄→「イタズラ菓子」。**sim のメカニクス (票・改変・thread) は全モードで同一**。判定分岐は verdict 適用点 (`ketsuStep`) と UI のみ。
- **C. モチーフ (公式テーマ第 1 弾の候補)** — §4.3 で比較。
- **D. UGC 化 (Roblox 段階)**: LexiconPack + ガチャ archetype + しきたり初期セット + スプライトマッピングを 1 つの「村テンプレ」として export/import 可能に。v1.5 以降 (まず A/B で pack 境界を切るのが前提)。

### 4.3 モチーフ候補の 4 軸比較

| モチーフ | 概要 (裁判/教育/追放の写像) | AI 学習量 | 作業コスト | 目的達成度 | 主目的一致 |
|---|---|---|---|---|---|
| **精霊の森 (推奨)** | 罪=穢れ / 裁判=禊の儀 / 教育=浄化 / 死刑→昇天=「森に還る」 | 中 | 小 (語彙のみ、どうぶつ素材そのまま) | **高 — 信仰軸・儀式演出と最も整合、CotL の教団感を無害に翻訳** | ◎ |
| 学園 | 事件=いたずら / 裁判=学級会 / 教育=補習 / 追放=転校 | 中 | 中 (スプライト替えが欲しくなる) | 高 — 分かりやすいが「村」の建付けと離れる | ○ |
| 牧場/保護区 | 裁判=お世話会議 / 教育=しつけ | 低 | 小 | 中 — 対立構造が弱くなり山場が鈍る | △ |
| 祭りの村 | 裁判=祭りの出し物 / 判決=奉納 | 中 | 小 | 中〜高 — 祝日システムとは好相性 | ○ |

**推奨: `classic` (現行) + `spirit-forest` (精霊の森) の 2 パック構成で開始。** 信仰徳目・祈り・儀式裁判・弔いのしきたりがそのまま「精霊信仰」に読み替わり、追加アセットなしで CotL 的な「かわいい宗教共同体」トーンが出る。

### 4.4 実装設計

- `packages/sim` — 変更なし (verdict の適用分岐だけ `moral` 引数を `ketsuStep` に渡す)。
- `packages/server/src/theme/lexicon.ts` 新設: pack ローダ (`data/theme/<pack>/lexicon.json`、キー欠落は起動時 fail-fast — 無言フォールバック禁止)。`trial-narrator` の糾弾プロンプト前置き・chronicle 文言・live feed 文言を pack 経由に置換。糾弾レパートリー (`denunciations.json`) は **pack 別ファイル**にする (トーン混線防止)。
- `packages/client`: UI ラベル/絵文字を snapshot 同梱の `theme` メタから引く。`wholesome` では有罪ボタン文言=「浄化」等。
- config: `theme.pack` (既定 `classic`) / `theme.moral` (既定 `balanced`)。切替は再起動で可 (ライブ切替は不要)。

---

## 5. 実装フェーズ / PR 分割

| フェーズ | 内容 | 依存 | 規模感 |
|---|---|---|---|
| **v1.4-A 介入の即時化** | heckle / testify / gift + cheer・アイテムの体感即時化 + 介入 2 点セット原則 (§3) | なし | sim+server+client 各中 |
| **v1.4-B 事件アーク** | PlotThread / incident-arcs.json / pickArcTheme / 小騒動 / 裁判バリエーション (§2) | A の testify が thread 生成点になる (弱依存) | sim 大 |
| **v1.4-C 蒸留ループ** | BehaviorRule v2 DSL / shadow-sampler / RuleSmith 蒸留 / rule-replay (§1) | なし (B と独立) | sim+server 中 |
| **v1.4-D テーマパック** | LexiconPack / モラルダイヤル / spirit-forest パック (§4) | なし | server+client 中 |

優先順位 (4 軸総合): **A → B → D → C**。A は作業コスト最小で観戦体験に直撃 (目的達成度最大)。B が飽き対策の本丸。D は A/B で見せ場が増えてから乗せると映える。C は効果が漸進的なので最後だが、AI 学習量の軸では最大 (蒸留ログ自体が研究素材)。

各フェーズ = 1 PR (AI 実装 1 PR 集約)。spot / fanFlames は v1.4-A' として A から分割可。

## 6. config 追加 (暗号化 config dotkey、すべて平文)

```
distill.sampleChance=0.02 / distill.minCases=5 / distill.acceptGain=0.1
arc.threadsMax=8 / arc.heatDecay=0.05 / arc.minorChance=0.25 / arc.minorDamageMax=2
intervene.heckleCost=3 / intervene.heckleCooldownMs=10000 / intervene.testifyCost=8
intervene.giftTreatCost=5 / intervene.giftPoisonCost=15 / intervene.spotCost=20 / intervene.fanCost=10
theme.pack=classic / theme.moral=balanced
```

## 7. テスト方針

- sim 新設 (`incident-arc` / `rule-replay` / `place-states` / trial-composer) はすべて純関数 or 決定的クラス → vitest 直行。thread 生成→月初選定→発火の一連は stub Brain の統合テスト (`test/incident-arc.test.ts`)。
- 蒸留: 教師出力を fixture (記録済み JSON) にして replay ゲートの採否を決定的に検証。shadow-sampler は fire-and-forget のため「sim 進行を 1ms もブロックしない」ことをタイマーテストで確認。
- テーマ: lexicon キー完全性テスト (pack 全キー存在で fail-fast が働くこと) + moral=wholesome で `verdict:'death'` が発生しないプロパティテスト。

## 8. 進行中作業との整合 (2026-07-02 時点の未コミット変更)

working tree に住民ガチャ (`villager-gacha.ts`) / 関係性 (`VillagerRelationship`) / 住民アクションログ / パーティイベントが進行中。本設計はこれらと衝突せず、むしろ接続先になる:

- 関係性 → BehaviorRule v2 の `relationTo` 条件 (§1.3a) と grudge thread の actors (§2.2) が消費者。**型が確定したら DSL 条件を合わせる。**
- パーティイベント (`plantPartyIncident`) → 小騒動/thread 加熱の生成点に追加。
- ガチャ archetype → テーマパックの UGC 対象 (§4.2 D)。

## 9. 開いた判断

- 蒸留 teacher の比較キー粒度 (行動カテゴリ一致で足りるか、感情方向も見るか) — まず両方記録して観戦で決める。
- 偽証 (testify accuse) の「発覚」判定: 決定的 (thread 化した時点で確定) か確率か。暫定 = 判決が誤りだった場合のみ確定発覚。
- PlaceState の場所粒度 (Place enum 単位 or grid 座標)。暫定 = Place 単位 (井戸/広場/畑…)。
- wholesome モードでの「旅立ち」住民の再登場可否 (殿堂入り §㉖ と統合するか)。暫定 = 再登場なし、殿堂表示のみ。
- spirit-forest の糾弾レパートリー種文 (8 件) の起草 — 実装 PR で同梱。
