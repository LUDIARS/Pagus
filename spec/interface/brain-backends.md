# Brain backends — マルチモデル分散 (v0.2)

`@pagus/sim` の `Brain` / `WorldBrain` を実 LLM で実装する際の **バックエンド抽象**を定める。
sim 側の契約 (`packages/sim/src/brain.ts` / `world-brain.ts`) は不変。実装は
`packages/server/src/llm/` に SRP 分割で置く。

## レイヤ構成

```
sim:    Brain / WorldBrain                 ← 契約 (LLM/transport 非依存)
server: LlmBrain / LlmWorldBrain           ← Brain 実装。backend を選び CLI を叩く
        ├ BackendRegistry                  ← villager → backend の準固定割当
        ├ prompt-build                     ← 各メソッドの system/user プロンプト (gateway 整形)
        ├ json-coerce                      ← LLM 応答 JSON → sim 型 の検証変換
        ├ CliLlmClient (LlmClient)         ← claude / codex CLI を spawn
        └ @ludiars/llm-gateway             ← orderSegments / pickTier / estimateTokens
```

## backend 抽象

```ts
interface Backend { id: string; provider: 'claude' | 'codex'; model: string; }
```

- **provider = transport の選択**。`claude` / `codex` の 2 系統。
- **API 不使用規約**: LLM 呼び出しは全て **CLI subprocess** で行う (Anthropic/OpenAI SDK を直接叩かない)。
  - `claude`: `claude -p --output-format json [--model <model>]`、プロンプトは stdin、出力は
    JSON エンベロープの `.result` を採る (Discutere `claude-cli.ts` をミラー)。OAuth (Lictor) で
    認証されるため API キー不要。
  - `codex`: `codex exec --model <model>`、プロンプトは stdin、出力は平文 stdout。
    Discutere `worker-pool/spawner.ts` の `BIN_BY_PROVIDER = { claude:'claude', codex:'codex' }`
    と `--model <model>` 引数形をミラー。standing worker (対話 TUI) と違い Brain は 1-shot なので
    非対話の `exec` サブコマンドを使う。
- **GPT-5.5 = `codex --model gpt-5.5`** (provider=`codex`, model=`gpt-5.5`)。Discutere DEFAULT_WORKERS の
  `{ provider:'codex', model:'gpt-5.5' }` に対応。

## デフォルトキャスト

| id | provider | model | 役割 |
|---|---|---|---|
| `opus` | claude | `claude-opus-4-8` | strong |
| `sonnet` | claude | `claude-sonnet-4-6` | 標準 |
| `haiku` | claude | `claude-haiku-4-5` | 軽量 |
| `gpt` | codex | `gpt-5.5` | 標準/strong |

claude 3 モデルに codex(gpt-5.5) を混ぜる = **村人ごとに別 LLM の脳**で動く分散構成。

## per-villager 割当

- `BackendRegistry.assign(villagerId)` が villagerId の決定的ハッシュ (FNV-1a) で
  キャストから 1 つを選ぶ。**再起動しても同じ村人は同じ脳**(準固定)。
- seed に初期割当 (`villagerId → backend.id`) があれば**それを尊重**する
  (`BackendRegistryOptions.initialAssignments`)。現行 seed には未設定。

## tier ルーティング (strong override)

`@ludiars/llm-gateway` の `pickTier` + `estimateTokens` で局面ごとに tier を決める
(`prompt-build.routeTier`)。

- **cheap (per-villager 割当)**: 起の行動決定 (`decideAction`) / 感情更新 (`updateEmotion`)。
- **strong (opus / gpt-5.5)**: 承GANs (`advanceIncident`) / 裁判 (`groupVoteFoolish` /
  `groupVoteFate`) / 教育 (`decideEducation`) / 世界評価 (`evaluateDay`)。
  `BackendRegistry.strong(key)` が strong 母集合 (`opus` / `gpt`) から決定的に選ぶ。
- 入力が大きい (`strongAboveTokens` 超) 局面も strong へ昇格する。

## プロンプト / 出力契約

- `prompt-build` が各メソッドの `system`(固定=prefix-cache の錨) と `user`(volatile=文脈) を組む
  (`orderSegments` で安定度順に整列)。
- 各プロンプトは **「JSON だけで返せ」** と指示し、返り値スキーマを sim 型に一致させる。
- `json-coerce` が応答 JSON を検証して sim 型へ変換。**parse 失敗は LlmBrain が 1 回リトライ→
  なお失敗なら throw**。
- **transport の一過性失敗** (spawn/timeout/非ゼロ終了/空出力) は `CliLlmClient` が backoff 付きで
  **リトライ** (既定 2 回 = `PAGUS_CLI_RETRIES`)。codex の Stop hook 由来 `exit 1` 等の一過性 blip を
  吸収し、全試行失敗で throw。これにより codex(gpt-5.5) を既定キャストに合流できる (`PAGUS_DISABLE_CODEX=1` で外す)。
- **無言フォールバック禁止** (RULE_CODE §7.1): 設定不正・応答不正は黙って既定値に落とさず必ず例外。リトライは「同じ呼び出しのやり直し」であってフォールバックではない。

## 起動切替

`PAGUS_BRAIN` (既定 `stub`):

- `stub`: `StubBrain` / `StubWorldBrain` (決定的・LLM 不使用)。テストと開発初期の既定。
- `llm`: `LlmBrain` (+ v0.5 で worldBrain 配線時に `LlmWorldBrain`)。
- 不正値は即エラー。
