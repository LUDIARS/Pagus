# Pagus 機能仕様書 (v0.0)

> 2026-06-25 起草。Notion 企画「AI村を作ろう」(開発ゼミ 研究テーマ) + ユーザ要件から導出。
> 仕様変更は本ファイル(および `spec/**`)への PR を正本とする。

## 1. コンセプト

村の住民 (村人) が LLM 駆動で自律的に行動し、**事件**を起こす。事件が起きると**審判人**が現れ、
**裁判** → **教育(改変)** を経て村人の姿かたち・性格が変わる。これを繰り返し、村がどう変容するかを試す。

- 主目的: 「シムズを超える」AI 感の実験。研究/ゼミプロトタイプとして **AI ループの反復速度**を最優先。
- ユーザ(プレイヤー)は事件の発生・内容を**扇動**でき、**沈静化**でき、第三者住民として**裁判に介入**できる。

## 2. 全体アーキテクチャ

ブラウザから `claude -p` CLI は呼べないため、**シミュレーションはサーバ権威**。クライアントは描画と入力のみ。

```
┌─────────────────────┐        WebSocket        ┌──────────────────────────────────┐
│ @pagus/client       │  state push / commands  │ @pagus/server (Node 権威)         │
│  Vite + PixiJS      │◀───────────────────────▶│  ├─ TermLoop driver (10 分/ターム)  │
│  ├─ 村ビュー(2D俯瞰) │                          │  ├─ @pagus/sim (権威 world state)  │
│  ├─ 事件フィード     │                          │  ├─ Brain 実装 = claude -p         │
│  ├─ 裁判 UI         │                          │  │    └ @ludiars/llm-gateway       │
│  └─ 扇動/沈静化操作  │                          │  └─ persistence (data/runtime)     │
└─────────────────────┘                          └──────────────────────────────────┘
```

- `@pagus/sim` は **LLM も描画も知らない**。AI 判断は `Brain` interface 越しにのみ要求する
  → server が `claude -p` 実装を注入、test は決定的 stub を注入。
- world state の正本は server プロセス内 (`@pagus/sim` の `World`)。client へは差分/スナップショットを push。

## 3. ドメインモデル — 村人 (ペルソナエンジン)

各村人は**独立したペルソナデータ**を持ち、「改変」で書き換わる。村人は出生/流入で**増え**、追放/死刑で**減る**。

行動は **「環境」+「感情」+「情報」→ 何らかランダムめいた行動** で決まる。

### 3.1 三分の責務

| 要素 | 決定主体 | 内容 |
|---|---|---|
| **環境 (Environment)** | プログラム | 村のどこにいるか、周囲のキャラ/物、時間帯(朝昼夜)。sim が算出 |
| **感情 (Emotion)** | **AI** | 現在の感情ベクトル。ゲーム開始時 + 各行動 tick で AI が更新 |
| **情報 (Information)** | 蓄積 | 村人が持つ知識/記憶。自分の行動・他者・プレイヤー入力で追加される |

### 3.2 Villager データ (確定スキーマは `spec/interface/sim-types.md`)

```ts
interface Villager {
  id: VillagerId;
  name: string;
  alive: boolean;            // false = 追放/死刑で退場 (以後登場しない)
  persona: Persona;          // 改変対象の全パラメータ
  emotion: EmotionState;     // AI が更新
  information: InfoItem[];    // 蓄積される知識/記憶
  position: GridPos;         // 環境 (プログラム算出)
  appearance: Appearance;    // 姿かたち (改変で変わる: 機械の体 等)
  species: string;           // どうぶつの種 (例: 猫, 梟, 兎)
  activity: ActivityPattern; // 活動特性 → 睡眠帯を決める
  reformCount: number;       // 改変された回数
}

interface Persona {
  traits: Record<TraitKey, number>;  // 例: aggression, kindness, curiosity ... (-1..1)
  values: string[];                   // 信条・行動原理 (自然言語)
  speechStyle: string;                // 口調
}
```

### 3.3 改変 (Reform)

教育内容により Persona / Appearance / Emotion の**全パラメータが変化**する (狂暴→温厚、機械の体 等)。
改変後はその村人として生活を続ける。**追放**された村人は以後登場しない。

### 3.4 どうぶつと睡眠

村人は**どうぶつ** (種を持つ)。種の `ActivityPattern` で睡眠帯が決まる。

| ActivityPattern | 起きているセグメント帯 (例) |
|---|---|
| `diurnal` (昼行性) | 朝〜夕 (seg 2..9) |
| `nocturnal` (夜行性) | 夜 (seg 0..2, 10..11) |
| `crepuscular` (薄明) | 朝夕の境 (seg 2..3, 8..9) |
| `always` | 常時 |

- **睡眠中は自律行動しない** (起のセグメントをスキップ)。
- ただし**誰かのアクションを受けたら起きる** (干渉で sleep が破られる)。
- 確定形は `spec/interface/sim-types.md`。

## 4. 時間モデル & ゲームループ

世界は**永続稼働 (24h)**。時間は実カレンダーに連動する三層の入れ子。

```
実時間 (連続)
└─ ゲーム内「月」= 実1日(24h) = 実カレンダーの当月に連動 (日数も: 6月=30日) → 四季・日本の祝日・大きな転換
     └─ ゲーム内「日」= 1ターム = 起承転結1回 = 実 24h ÷ その月の日数 ≈ 46分(31日月)/48分(30日月)
          └─ 12 セグメント (時間帯) ≈ 各 3.8〜4分 = イベント/変化の発生粒度・睡眠帯
```

- **実時間長は導出値** (自由 config ではない): `termRealMs = 24h ÷ daysInRealMonth`、`segmentRealMs = termRealMs ÷ 12`。
- 月の遷移 = 実 1 日境界。ゲーム内月のテーマ (季節・祝日) は**実 `Date` から引く** (現実 6 月 → 夏 + 6 月の祝日)。
- sim 核は**壁時計を持たない**。server がカレンダー由来 (本番) or 加速 (dev) のペースで `advanceSegment()` を呼ぶ。
- AI 起動点は本書で **(AI)** と明示する。

### 4.1 起承転結ステートマシン (1 ターム = 1 日)

1 日 (1 ターム) は 12 セグメントを進みながら起承転結を一巡する。各セグメントで「何か変化(小イベント)」が出る。
事件 (大イベント) が発火すると承→転→結が走り、解決後に残りセグメント or 日末へ。

```
       ┌─────────────────────────── 1 DAY = 1 TERM (12 segments) ───────────────────────────┐
 IDLE ▶│ 起 KISHO (seg ごとに自律行動/小イベント) ─事件発火▶ 承 SHO ─収束▶ 転 TEN ─審判▶ 結 KETSU │
       │   ▲ 起へ戻り残seg消化       GANs              裁判         教育/追放               │
       │   └───────────────────────────────────────────────────────────────────────────────┘
       └▶ seg==12 で REFORM 適用 ─▶ ADVANCE_DAY (日++ → 月境界なら月遷移/季節/祝日) ─▶ 次の日
```

### 4.2 起 (KISHO) — セグメント駆動

- 各セグメントで環境/感情/情報をベースに (AI) 行動を要求し、行動と感情を書き換える。
- **睡眠中のどうぶつはセグメントをスキップ** (誰かのアクションを受けた場合のみ起きる)。§3.4。
- イベント化する行動が出たら **承** へ。出なければ次セグメントへ進み、seg==12 で日を終える。

### 4.3 承 (SHO) — 事件 (イベント)

- 事件確定: **当事者(加害者)**が決まり、**周囲の村人が巻き込まれる**。
- ユーザへ事件を提示。ユーザは**扇動 / 沈静化**を選択可。
- **(AI) GANs ロジックで進行**: 加害者視点の行動 → 被害者視点の行動を**別コンテキスト**で交互実行。
- 事件終了 (被害レベルが閾値超) を常に (AI) に問い合わせ。終了で **転** へ。

### 4.4 転 (TEN) — 審議 (裁判)

- **審判人**が登場 (基本は最強超人「猫守さん」。教育済み村人が登場することも)。
- 審判人 vs 当事者で審議(バトル)。内容は自由 (以下は仮)。
- **(AI) 裁判 = 3 点先取**で「死刑 / 有罪 / 無罪」を決定。
  - 加害者視点 → 被害者視点を**別コンテキスト**で実行。
  - ユーザは当事者でない第三者住民として介入可。
- 審判決定で **結** へ。

### 4.5 結 (KETSU) — 教育

- 無罪: 平和に終了。
- 有罪/死刑: 審判の神(猫守さん)の教育開始。
  - **(AI) 教育内容を決定** → 村人を**教育(改変)** または **追放**。

### 4.6 住民改変 / 日・月の進行

- 日末 (seg==12) に改変を適用 (§3.3)。
- 日が進む (day++)。日数がその月の日数を超えたら**月遷移** = 実 1 日境界の「大きな転換」。
- 月遷移時: 季節・日本の祝日を実 `Date` から再評価し、該当すれば**祝日イベント**を起こす (§4.7)。

### 4.7 カレンダー / 季節 / 祝日

- `season(month)`: 3-5 春 / 6-8 夏 / 9-11 秋 / 12-2 冬。
- `daysInMonth(year, month)`: 実カレンダー (閏 2 月対応)。ターム実時間長の分母。
- `holidayName(month, day)`: 日本の祝日テーブル。春分/秋分は近似 (確定形は `spec/data/holidays.md`)。
- 祝日に当たる日はその祝日にまつわるイベントを (AI) が生成 (将来; v0.5+)。

### 4.8 ユーザ確認イベント / 通知投票 (将来 v0.6+)

- ユーザ確認が必要なイベント発生時、**接続中の各ユーザへ通知**を飛ばし、確認・議論・**投票**を促す。
- 通知は Memoria の WebPush / Nuntius 系の知見を流用予定。投票結果が事件・裁判の分岐に反映される。
- 確定形は `spec/interface/notification-voting.md` (v0.6 で起草)。

## 5. AI (Brain) インターフェース

sim は次の `Brain` を DI で受ける (確定形は `spec/interface/brain.md`)。server が `claude -p` で実装。

```ts
interface Brain {
  // 起: 環境+感情+情報 から次の行動と新感情を決める
  decideAction(ctx: ActionContext): Promise<ActionDecision>;
  // 承: GANs 進行 (視点ごとに別コンテキスト) + 事件終了判定
  advanceIncident(ctx: IncidentContext): Promise<IncidentStep>;
  // 転: 裁判の 1 ラウンド (3 点先取の 1 点)
  judgeRound(ctx: TrialContext): Promise<TrialRound>;
  // 結: 教育内容 (改変 diff) を決める
  decideEducation(ctx: EducationContext): Promise<Reform>;
  // 感情の初期化/更新も Brain 経由
  updateEmotion(ctx: EmotionContext): Promise<EmotionState>;
}
```

### 5.1 LLM tier (コスト方針)

`@ludiars/llm-gateway` の `pickTier` で振り分け:

| 用途 | kind | tier | モデル目安 |
|---|---|---|---|
| 起 tick / 感情更新 | `action`, `emotion` | cheap | Haiku |
| 承 GANs 進行 | `incident` | strong | Sonnet |
| 裁判 | `trial` | strong | Sonnet/Opus |
| 教育 | `education` | strong | Opus |

- プロンプトは `orderSegments` で安定プレフィックス順に整列 (prefix cache 効かせる)。
- 履歴は `rollingSummary` で予算内に畳む。
- **無言フォールバック禁止**: モデル ID / backend 経路未設定なら即エラー (RULE_CODE §7.1)。

### 5.2 マルチ LLM 分散 (Discutere 方式) + GPT-5.5

どうぶつの「思考」は**単一モデルに集約せず、複数 LLM に分散**する (Discutere の LLM backend 切替設計を踏襲)。
これにより個体ごとの思考の癖が分かれ、村の創発が豊かになる。

- **backend レジストリ**: `claude -p` (Opus/Sonnet/Haiku の各モデル) に加え **GPT-5.5** を 1 backend として登録。
- **個体↔backend 割当**: どうぶつごとに思考 backend を (準) 固定で割り当てる (Di の persona↔model 割当と同型)。
  sim は LLM を知らないので、割当は server が `villagerId → backendId` で保持 (seed に初期割当)。
- **役割別 override**: 裁判/教育など重い局面は割当に依らず strong tier (Opus/GPT-5.5) へ寄せられる (§5.1 と併用)。
- **transport**: Claude は `claude -p` CLI。GPT-5.5 の呼び出し経路は **Discutere の backend 実装に合わせる** (CLI/gateway/API のどれかを v0.2 着手時に Di 実装で確認・統一)。LUDIARS の「API 不使用」規約との整合は Di の前例に準拠。
- 確定形は `spec/interface/brain-backends.md` (v0.2 で起草)。

## 6. クライアント UI

- **村ビュー**: 2D トップダウン。村人スプライトが移動、時間帯で色調変化。
- **事件フィード**: 起承転結の進行をテキスト + ハイライト表示。
- **裁判 UI**: 3 点先取スコア、加害者/被害者/審判人の主張、ユーザ介入入力。
- **操作**: 扇動 (事件を煽る) / 沈静化 / 情報を村人に教える / 裁判介入。

## 7. プロトコル (WS)

確定形は `spec/interface/ws-protocol.md`。概略:

- server→client: `world.snapshot` / `world.patch` / `phase.changed` / `incident.update` / `trial.update`
- client→server: `cmd.incite` / `cmd.calm` / `cmd.inform` / `cmd.trialIntervene`

## 8. データ配置 (アンカー)

```
data/
├─ villagers/seed.json       初期どうぶつシード (種 / 活動特性 / 位置)
├─ prompts/                  Brain 用プロンプトテンプレ (用途別)
├─ world.config.json         グリッドサイズ / segmentsPerDay(12) / 被害閾値 / 裁判先取点
├─ holidays.json             日本の祝日テーブル (将来)
└─ runtime/                  実行時 world スナップショット (gitignore)
```

実時間ペース (termRealMs/segmentRealMs) は config に持たず**カレンダーから導出**。dev 加速は server の起動オプション。

詳細は `spec/data/`。

## 9. 非機能 / 規約

- **環境=プログラム / 感情=AI** の分離を崩さない (sim に LLM 依存を入れない)。
- LLM は `claude -p` のみ (API 不使用)。
- SRP / ファイル分割必須 (`/coding-conventions`)。
- 設定不備は即エラー (無言フォールバック禁止)。

## 10. ロードマップ

| Milestone | 内容 |
|---|---|
| **v0.0** | scaffold + 本 spec + sim 核型 + 起承転結ステートマシン骨格 |
| **v0.1** | 時間モデル刷新 (日=ターム/12セグメント/カレンダー/季節/祝節) + どうぶつ睡眠 + 起ループ(stub) + client 村ビュー + WS 配信 |
| v0.2 | claude -p Brain 実装 (感情/行動)・llm-gateway 配線・起→承 発火 |
| v0.3 | 承 GANs + 事件フィード UI + 扇動/沈静化 |
| v0.4 | 転 裁判 (3 点先取) + 裁判 UI + 第三者介入 |
| v0.5 | 結 教育/改変 + 住民改変適用 + 祝日イベント生成 |
| v0.6 | 村人増減 (出生/流入) + マルチユーザ通知投票 + 永続化 + バランス調整 |

## 11. 開いている設計判断

- 描画: PixiJS で確定 (game-engine 非依存の純描画 + sim 分離のため)。Phaser は不採用。
- 村人 ID: ULID か UUIDv7 → **UUIDv7** 仮 (時系列ソート可)。
- GANs の「別コンテキスト」具体形 (会話履歴の分離単位) は v0.3 で確定。
- セグメント駆動 (server が segmentRealMs ごとに advanceSegment、client は補間) で確定。dev は加速。
- ゲーム内月のテーマは実 `Date` から引く (現実 6 月 → 夏)。in-game 月カウンタの扱い詳細は v0.5 で詰める。
- 春分/秋分など変動祝日の正確な日付算出は近似で開始、v0.5 で天文計算 or テーブルに差し替え。
- 「誰かのアクションで睡眠が破れる」干渉モデルの具体 (対象指定の経路) は v0.3 で確定。
- 永続化形式 (JSON スナップショット vs SQLite) は v0.6 で確定。
