# Pagus ドメイン & 機能カタログ (Anatomia / Thaleia 向け)

> 2026-07-02 作成。Anatomia (実装の構造グラフ / ドメイン分類) がドメインノードとして取り込み、
> Thaleia (企画↔実装トレーサビリティ) が企画粒度の機能一覧として突合できる形でまとめる。
> 設計正本は [`spec/SPEC.md`](../spec/SPEC.md)、企画正本は Notion「AI村を作ろう」。UX は [`docs/ux.md`](./ux.md)。

## 1. プロダクト一行定義

LLM 駆動のどうぶつ村人が自律的に **事件 → 裁判 → 教育(改変)** を繰り返す永続稼働の創発シミュレーション。
観客(プレイヤー)は村の外から扇動・制裁・応援・賭けで介入し、村の変容を集団で楽しむ。

## 2. アーキテクチャ大分類 (レイヤノード)

| レイヤ | パッケージ | 責務 | 依存制約 |
|---|---|---|---|
| シミュレーション核 | `@pagus/sim` | 純 TS。世界状態・起承転結ステートマシン・全メカニクス。**LLM と描画を知らない** | `Brain`/`WorldBrain` interface を DI で受けるのみ |
| 権威サーバ | `@pagus/server` | sim の駆動 (カレンダーペース)、LLM 実装 (`claude -p` / `codex exec`)、WS/HTTP 配信、永続化 | sim に依存。LLM は CLI のみ (API 不使用) |
| 観戦クライアント | `@pagus/client` | Vite + PixiJS。2D 村ビュー・裁判劇場・操作 UI。状態を持たない (描画と入力のみ) | WS 越しに server とだけ話す |

基本原則 (型レベルで分離): **環境 = プログラム / 感情 = AI(→v1.0 以降はデータ駆動ルール) / 情報 = 蓄積**。

## 3. ドメインマップ (Anatomia 用ノード一覧)

各ドメイン = グラフの 1 ノード。`実装` 列が code アンカー、`spec` 列が設計アンカー。

### D1. 時間・暦

実カレンダー連動の三層入れ子。ゲーム内「月」= 実 1 日 (24h)、「日」= 1 ターム = 起承転結 1 巡 ≈ 46分、1 日 = 12 セグメント (≈4分) が行動・睡眠の粒度。季節・日本の祝日 (春分/秋分は天文計算) を実 `Date` から引き、祝日イベントを発火。

- 実装: `sim/src/calendar.ts`, `server/src/clock.ts`, `server/src/term-loop.ts`
- spec: SPEC §4, §4.7

### D2. 村人 (ペルソナエンジン)

どうぶつの村人。気質 6 軸 (優しさ/攻撃性/社交性/好奇心/規律/野心) + 信条 + 口調 + 感情 + 情報(記憶)。種と活動特性 (昼行性/夜行性/薄明/常時) が睡眠帯を決める。裁判の「教育」で全パラメータが**改変**される。出生/流入で増え、追放/死刑で減る。狂人 (madman)・ストレス耐性・結婚/出産・所持金/趣味を持つ。

- 実装: `sim/src/types/villager.ts`, `sim/src/villager-factory.ts`, `sim/src/personality.ts`
- spec: SPEC §3, §8A.1, §8B.5–8B.6

### D3. 日常行動エンジン (LLM 不使用)

起 (KISHO) の日常行動・感情は LLM を呼ばず、**BehaviorRule (閉じた安全 DSL) の決定的評価**で決まる。Haiku が日末に低確率でルールを 1 つ生成・追加し (RuleSmith)、村の挙動がルール蓄積で創発的に複雑化する。イベント 3 種 (嫌がらせ/良い行動/雑談) はグループ代表が起こす。

- 実装: `sim/src/daily-engine.ts`, `sim/src/behavior-rules.ts`, `sim/src/event-director.ts`, `sim/src/events.ts`
- spec: SPEC §12.2, `spec/feature/cost-reduction-redesign.md` §2

### D4. 事件ライフサイクル

月初に世界側 LLM が**その月の事件発生日**を決め、前日に村の様子から**詳細デザイン + 事件用キャラ生成** (露出狂/殺人犯など。罪を擦り付けて居座る連続犯も許容)。承 (SHO) では当事者だけ LLM 脳で応答 (GANs 的に加害者/被害者を別コンテキスト交互実行)。和解・二次被害・ストレス受け流しの確率分岐あり。

- 実装: `sim/src/term-machine.ts` (`scheduleMonthlyIncident`/`designScheduledIncident`/`fireScheduledIncident`), `sim/src/types/incident.ts`, `sim/src/world-brain.ts`
- spec: SPEC §4.3, §12.3, §8B.2–8B.3

### D5. 裁判・教育

転 (TEN) = 投票裁判。被告選び (foolish、制裁時はスキップ) → 判決 (fate) は**死刑 / 教育の 2 択**。票は住民グループ bloc + 接続ユーザ (userId ごと 1 席) + 狂人の扇動加重を合算。糾弾セリフは 65% Haiku 新規生成 + 35% レパートリー再利用。結 (KETSU) = 教育で改変 (いじられ方を `ReformSummary` でログ) or 死刑で退場。

- 実装: `sim/src/types/trial.ts`, `sim/src/term-machine.ts`, `server/src/trial-narrator.ts`, `server/src/repertoire.ts`
- spec: SPEC §4.4–4.5, §5.3, §12.5, §8B.1, §8B.4, §8B.7

### D6. 評判・世界評価

村の徳目 6 軸 (善良/悪辣/秩序/活気/知性/信仰)。気質 6 軸と 1:1 対応 (優しさ→善良 …)。日末に裁判結果をアルゴリズム集計して村・個体ベクトルを更新し、村ベクトルに偏った個体が出生する (出生バイアス)。

- 実装: `sim/src/world.ts`, `sim/src/virtue.ts`, `sim/src/world-brain.ts`
- spec: SPEC §8A

### D7. 住民経済

住民 (NPC) の所持金 `wealth`。貧富の差 (決定的初期散布)、趣味嗜好 (質素/蒐集/社交/着飾り/美食/賭博) に従う日末消費、貧困→非行 (事件化しやすくなる)、富裕→クズ化 (浪費 + プレイヤーにカルマをたかる)、NPC 間の推し送金。プレイヤーのカルマとは別通貨。

- 実装: `sim/src/economy.ts` + `sim/src/behavior-rules.ts` の wealth ルール
- spec: SPEC §15, `spec/feature/villager-economy.md`

### D8. フィールドアイテム

プレイヤーがフィールドへランダム配置 (カルマ消費なし)。貴金属 💎 = 所持金+ (クズ化の誘因)、薬物 💊 = 怒り+/所持金− → 非行連動。日末に最寄り住民が拾得。推しへの直送も可。

- 実装: `sim/src/items.ts`
- spec: SPEC §16, `spec/feature/field-items.md`

### D9. 政治

**村長 = 村人の 1 体**。選挙イベント (人気度アルゴリズム、周期 ≈ゲーム内 1 年) で就任、半年前から匿名世論調査、プレイヤーはカルマでリコール請願。法案投票 / 革命 (蜂起) / 戒厳令 (事件凍結⇄多発) / 税 (村基金)。しきたり (村のルール) はプレイヤーがカルマで増減でき、**次月の事件デザインの入力**になる = 火種を書く。

- 実装: `sim/src/mayor.ts`, `server/src/governance.ts`, `sim/src/village-rules.ts`
- spec: SPEC §17, §14.C, `spec/feature/villager-mayor.md`, `spec/feature/multiplayer-social.md` §2

### D10. プレイヤー状態・ソーシャル

userId ごとのカルマ (時間経過で自動蓄積) と善性 (virtue)。操作 = **扇動** (対象 1 体 + 偽の噂注入、カルマ消費) / **制裁** (当日つるし上げ裁判、善性に比例して高額) / **応援** (対象パラメータ+、3 分インターバル)。**推し指名** (生存中カルマ加速、死で損失 + 村に追悼のしきたりが残る = 弔い) / **裁判ベット** (死刑/教育にパリミュチュエル) / **称号** (破壊神/聖人/立法者/博徒…) / **二大陣営** (善導 vs 扇動の徳目綱引き)。

- 実装: `server/src/player-state.ts`, `server/src/bet-pool.ts`, `sim/src/term-machine.ts` (`inciteTarget`/`sanction`/`cheer`)
- spec: SPEC §12.4, §13, `spec/feature/multiplayer-social.md`

### D11. カード・演出・協力 (ソーシャルパック)

カード: 天災 (一時ルール) / 神隠し (裁判逃れ) / 入替 / 覚醒 / 偽予言。経済系: オークション / 推し保険 / 闇市 (復活)。演出協力: ハイライト / 予測アワード / 月間 MVP / 観客の祈り / 共闘レイド / シーズン制。課金モック + ユーザコード認証。

- 実装: `server/src/auction.ts`, `server/src/spectacle.ts`, `server/src/user-code.ts`, `client/src/{card-panel,economy-panel,spectacle-panel,account-panel}.ts`
- spec: SPEC §14, `spec/feature/social-packs-v1.3.md`

### D12. 通知・多人数投票

裁判が開くと離席端末へ WebPush (VAPID)。通知クリック → 観戦タブ → 投票。票は userId ごと 1 席の重み合算、WS / HTTP (`POST /api/vote`) の両経路。投票し直し可。

- 実装: `server/src/{push-service,http-api}.ts`, `client/src/push-client.ts`, `client/public/sw.js`
- spec: SPEC §4.8, `spec/interface/notification-voting.md`

### D13. LLM 基盤

LLM は **CLI のみ** (LUDIARS 規約、API 不使用): Claude = `claude -p`、GPT-5.5 = `codex exec`。マルチ LLM 分散 (Discutere 方式) = どうぶつごとに思考 backend を準固定割当。tier: 事件/裁判/教育 = strong (Sonnet/Opus/GPT-5.5)、糾弾/ルール生成 = cheap (Haiku)。一過性エラーは CLI レベルリトライで吸収。コストログ (用途/モデル/トークン/概算)。**設定不備の無言フォールバック禁止 = 即エラー**。

- 実装: `server/src/llm/` (backend-registry, cli-llm-client, llm-brain, llm-world-brain, cost-log, prompt-build)
- spec: SPEC §5, `spec/interface/brain-backends.md`

### D14. 永続化・設定

world スナップショット (`data/runtime/world.json`) = どうぶつ状態・評判・暦・進行中の事件/裁判を JSON 保存 → 再起動復元。村の歴史 (`chronicle.json`、節目をゲーム内日付つきで上限 500 件)、糾弾プール、push 購読。チューニング値と秘密は `@ludiars/encrypted-config` の単一 config (`pnpm pagus:config`) に集約。

- 実装: `server/src/world-store.ts`, `server/src/chronicle.ts`, `server/src/config/`
- spec: SPEC §8, §8B.8, CLAUDE.md「起動 / 観戦」

### D15. 配信プロトコル・観戦 UI

WS で snapshot/patch を push (server=4310, client=4320, 同一オリジン `/ws` proxy)。UI は 3 カラム (左=被告ステータス / 中央=村シーン⇄裁判シーンの PixiJS ステージ + ログ / 右=徳目レーダー・投票・経済・政治パネル)。動物スプライト (Kenney CC0)、アニメ吹き出し、当事者フォーカス、裁判劇場、断末魔、📜 村の歴史モーダル、行動ドック + メニューオーバーレイ (レスポンシブ)。

- 実装: `sim/src/protocol.ts`, `server/src/ws-server.ts`, `client/src/` 全般 (village-scene, trial-scene, hud, action-overlay ほか)
- spec: SPEC §6, §7

## 4. 機能カタログ (Thaleia 用: 企画粒度)

企画項目 → 状態 → 正本参照。全項目 main 実装済 (2026-07-02 時点、v1.3 まで)。

| # | 機能 (企画粒度) | ドメイン | 状態 | 参照 |
|---|---|---|---|---|
| F01 | 実カレンダー連動の時間モデル (月=実1日 / 日=ターム / 12セグメント) | D1 | ✅ v0.1 | SPEC §4 |
| F02 | 季節・祝日イベント (春分/秋分は天文計算、AI 実発火) | D1 | ✅ v0.6 | SPEC §4.7 |
| F03 | どうぶつペルソナ (気質6軸 / 種 / 睡眠帯 / 三分原則) | D2 | ✅ v0.1 | SPEC §3 |
| F04 | 教育による改変 (persona/appearance/emotion 全書き換え + いじられ方ログ) | D2/D5 | ✅ v0.5 | SPEC §3.3, §8B.7 |
| F05 | 起承転結ステートマシン (1日 = 起→事件→裁判→教育の 1 巡) | D1/D4/D5 | ✅ v0.0–0.5 | SPEC §4.1 |
| F06 | 日常 = BehaviorRule 決定的評価 (日常 LLM 全廃) | D3 | ✅ v1.0 | SPEC §12.2 |
| F07 | ふるまいの法則の自動増殖 (Haiku が日末に低確率でルール追加) | D3 | ✅ v1.1 | SPEC §12.2.1 |
| F08 | 事件の月初スケジュール + 前日詳細デザイン + 事件用キャラ生成 | D4 | ✅ v1.0 | SPEC §12.3 |
| F09 | 承 GANs 進行 (加害/被害を別コンテキスト交互、当事者のみ LLM) | D4 | ✅ v0.3/v1.0 | SPEC §4.3 |
| F10 | 和解 / 二次被害 / ストレス受け流し (事件の確率分岐) | D4 | ✅ v0.5+ | SPEC §8B.2–8B.5 |
| F11 | 投票裁判 (被告選び → 死刑/教育 2 択、bloc+ユーザ+狂人合算) | D5 | ✅ v0.4/v1.0 | SPEC §4.4, §12.5 |
| F12 | 糾弾セリフの Haiku 生成 + レパートリー蓄積 | D5 | ✅ v0.5+ | SPEC §5.3 |
| F13 | 狂人 (無実の善人を陥れる扇動投票) | D5 | ✅ v0.5+ | SPEC §8B.1 |
| F14 | 徳目6軸の村評判 + 日末評価 + 出生バイアス | D6 | ✅ v0.5/v1.0 | SPEC §8A |
| F15 | 結婚・出産 (夫婦から気質ブレンドの子) | D2 | ✅ v0.5+ | SPEC §8B.6 |
| F16 | 住民経済 (貧富 / 趣味消費 / 非行 / クズ化 / NPC 推し送金) | D7 | ✅ | SPEC §15 |
| F17 | フィールドアイテム (💎貴金属 / 💊薬物、ランダム配布) | D8 | ✅ | SPEC §16 |
| F18 | 村長 = 村人の選挙 (世論調査 / リコール) | D9 | ✅ | SPEC §17 |
| F19 | 政治パック (法案 / 革命 / 戒厳令 / 税) | D9 | ✅ v1.3-C | SPEC §14.C |
| F20 | しきたり改定 (プレイヤーが村のルール = 事件の火種を書く) | D9/D10 | ✅ v1.2-A | SPEC §13.2 |
| F21 | カルマ & 善性 (自動蓄積 / 善人ほど制裁が高い) | D10 | ✅ v1.0 | SPEC §12.4 |
| F22 | 扇動 (対象指定 + 偽の噂注入) / 制裁 (つるし上げ裁判) / 応援 | D10 | ✅ v1.0 | SPEC §12.4 |
| F23 | 推し指名 + 弔い (死が追悼のしきたりとして村に残る) | D10 | ✅ v1.2-A | SPEC §13.1 |
| F24 | 裁判ベット (死刑/教育のパリミュチュエル) | D10 | ✅ v1.2-B | SPEC §13.3 |
| F25 | 称号・二大陣営 (善導 vs 扇動のスコアボード) | D10 | ✅ v1.2-B | SPEC §13.4 |
| F26 | カードパック (天災 / 神隠し / 入替 / 覚醒 / 偽予言) | D11 | ✅ v1.3-A | SPEC §14.A |
| F27 | 経済パック (オークション / 推し保険 / 闇市復活) | D11 | ✅ v1.3-B | SPEC §14.B |
| F28 | 演出協力パック (ハイライト / 予測 / MVP / 祈り / レイド / シーズン) | D11 | ✅ v1.3-D | SPEC §14.D |
| F29 | 課金モック + ユーザコード認証 | D11 | ✅ v1.3-F | SPEC §14.F |
| F30 | WebPush 通知投票 (離席端末を裁判へ呼び戻す) | D12 | ✅ v0.6 | SPEC §4.8 |
| F31 | マルチ LLM 分散 (Claude 各 tier + GPT-5.5、個体↔backend 割当) | D13 | ✅ v0.2 | SPEC §5.2 |
| F32 | LLM コストログ / 状態パネル | D13 | ✅ v1.0 | SPEC §12.7 |
| F33 | world スナップショット永続化 + 村の歴史 (Chronicle) | D14 | ✅ v0.6 | SPEC §8B.8 |
| F34 | 暗号化 config への設定集約 (env ~70 個を統合) | D14 | ✅ | CLAUDE.md |
| F35 | PixiJS 観戦 UI (村シーン / 裁判劇場 / 3 カラム + モバイルドロワー) | D15 | ✅ v0.5+/v1.3-E | SPEC §6 |

### 企画↔実装の突合メモ (Thaleia 向け)

- 「企画されたが未実装」: 現時点なし (§13.5 バックログのうち送金・銀行・プレイヤー村長は**廃止**であって未実装ではない — SPEC §14 の廃止注記を正とする)。
- 「実装されたが企画外」: なし (実装はすべて spec/feature/*.md に正本化済)。
- 残タスクの性質: **数値バランスのみ** (SPEC §11) — 観戦して env/config で調整する運用パラメータであり、構造的な開いた設計判断は解消済。

## 5. 用語辞典 (グラフのエッジラベル用)

| 用語 | 意味 |
|---|---|
| ターム | ゲーム内 1 日 = 起承転結 1 巡 ≈ 実 46 分 |
| 起 / 承 / 転 / 結 | 日常 / 事件 / 裁判 / 教育 のフェーズ名 |
| 改変 (Reform) | 教育による村人パラメータの書き換え |
| カルマ | プレイヤー通貨 (時間で自動蓄積、介入で消費) |
| 善性 (virtue) | プレイヤーの善行度。制裁コストを引き上げる |
| しきたり (VillageRule) | 村のルール。次月の事件デザインの種 |
| 推し (champion) | プレイヤーが指名する 1 体。死ぬと弔いが残る |
| 狂人 (madman) | 裁判を扇動し無実の善人を陥れる住民 |
| ピュアブリード | `reformCount === 0` の未改変住民 |
| 事件用キャラ | 事件のために LLM 生成される専用住民 (連続犯になりうる) |
