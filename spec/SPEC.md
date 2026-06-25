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

## 4. ゲームループ — ターム (1 ゲーム)

- **1 ターム = 10 分**。起承転結で進行し、終了で「住民改変」+ 時間進行 (朝→昼→夜)。
- AI 起動点は本書で **(AI)** と明示する。

### 4.1 起承転結ステートマシン

```
        ┌──────────────────────────────────────────────────────────────┐
        │                          TERM (10 min)                       │
        │                                                              │
 IDLE ─▶│ 起 KISHO ─事件発火─▶ 承 SHO ─収束─▶ 転 TEN ─審判─▶ 結 KETSU │─▶ REFORM ─▶ ADVANCE_TIME ─▶ (次ターム)
        │   ▲   │              GANs        裁判        教育/追放      │
        │   └───┘ 事件出るまでループ                                   │
        └──────────────────────────────────────────────────────────────┘
```

### 4.2 起 (KISHO) — 2〜5 分

- 環境を提示。村人が勝手に動き回る。
- **環境/感情/情報をベースに ~10 秒に 1 回 (AI) 行動を要求**し、行動と感情を書き換える。
- イベント化する行動が出たら **承** へ遷移。出なければ事件発生までループ。

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

### 4.6 住民改変 / 時間進行

- ターム終了で改変を適用 (§3.3)。
- 時間が 朝→昼→夜 と進む (環境に反映)。

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
- **無言フォールバック禁止**: モデル ID / API 経路未設定なら即エラー (RULE_CODE §7.1)。

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
├─ villagers/seed.json       初期村人シード
├─ prompts/                  Brain 用プロンプトテンプレ (用途別)
├─ world.config.json         グリッドサイズ / ターム長 / tick 間隔 / 時間帯
└─ runtime/                  実行時 world スナップショット (gitignore)
```

詳細は `spec/data/`。

## 9. 非機能 / 規約

- **環境=プログラム / 感情=AI** の分離を崩さない (sim に LLM 依存を入れない)。
- LLM は `claude -p` のみ (API 不使用)。
- SRP / ファイル分割必須 (`/coding-conventions`)。
- 設定不備は即エラー (無言フォールバック禁止)。

## 10. ロードマップ

| Milestone | 内容 |
|---|---|
| **v0.0** | scaffold + 本 spec + sim 核型 + 起承転結ステートマシン骨格 (本 PR) |
| v0.1 | 起ループ実装 (stub Brain で村人移動・tick) + client 村ビュー + WS 配信 |
| v0.2 | claude -p Brain 実装 (感情/行動)・llm-gateway 配線・起→承 発火 |
| v0.3 | 承 GANs + 事件フィード UI + 扇動/沈静化 |
| v0.4 | 転 裁判 (3 点先取) + 裁判 UI + 第三者介入 |
| v0.5 | 結 教育/改変 + 住民改変適用 + 時間進行 |
| v0.6 | 村人増減 (出生/流入) + 永続化 + バランス調整 |

## 11. 開いている設計判断

- 描画: PixiJS で確定 (game-engine 非依存の純描画 + sim 分離のため)。Phaser は不採用。
- 村人 ID: ULID か UUIDv7 → **UUIDv7** 仮 (時系列ソート可)。
- GANs の「別コンテキスト」具体形 (会話履歴の分離単位) は v0.3 で確定。
- ターム内の tick とリアルタイム描画の同期方式 (server tick = sim、client は補間) は v0.1 で確定。
- 永続化形式 (JSON スナップショット vs SQLite) は v0.6 で確定。
