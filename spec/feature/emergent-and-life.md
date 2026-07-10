# 創発・生活メカニクス / 観戦UI — 実装リファレンス

> SPEC.md §8B / §5.3 / §6 の実装追補をファイル単位で集約した索引。
> 数値は当て推量で、観戦して調整する前提 (env で可変)。最終更新 2026-06-26。

## メカニクス (sim / server)

| 機能 | 概要 | 主な実装 |
|---|---|---|
| 狂人 (madman) | 村の評判(悪辣/無秩序)に応じ裁判を扇動。foolish=最も善良な候補へ、fate=「殺す」へ重い票を上乗せ → 無実が陥れられる。重み `round(1+悪辣×5+(1−秩序)×2)` | `sim/term-machine.ts` (`aliveMadman`/`madmanWeight`/`scapegoat`)、seed `v_nushi` |
| 和解 (reconcile) | 承の各ステップで確率判定。成立で裁判に至らず収束。沈静化で↑/扇動で↓ (事件毎に0リセット) | `sim/term-machine.ts` (`shoStep`/`nudgeCalm`/`nudgeIncite`) |
| 二次被害 (secondary) | 承の各ステップで確率、第三者を巻き込み被害+2 | `sim/term-machine.ts` (`shoStep`) |
| ストレス耐性 | 事件/裁判で `stress`+1。被害者平均stressで嫌がらせを受け流し事件化を抑制 (`min(0.8, 平均×K)`) | `sim/term-machine.ts` (`shrugsOff`/`startIncident`) |
| 結婚・出産 | 日末 `lifeEvents`。未婚2体が結婚(`partnerId`)、夫婦から気質ブレンドの子 | `sim/term-machine.ts` (`lifeEvents`/`spawnChild`)、`test/village-life.test.ts` |
| 改変ログ | `applyReform` が「どういじられたか」(気質↑↓/体/信条/口調 or 追放理由) を `ReformSummary` で返す | `sim/term-machine.ts` (`reform`)、`server/term-loop.ts` |
| Haiku 糾弾 | 裁判開始時、糾弾者ごとに65%生成(保存)/35%再利用。プールは成長 | `server/{trial-narrator,repertoire}.ts`、`server/index.ts` (onTrialOpen) |
| 村の歴史 | 節目を日付つきで永続化、接続時+発生毎に配信 | `server/chronicle.ts`、`server/index.ts` (`isMilestone`) |
| 祝日イベント | 春分/秋分を年から天文計算 (`vernalEquinoxDay`/`autumnalEquinoxDay`)。祝日にあたる日に (AI) が祝祭を実発火 (`📅`、評判を活気寄りに微調整) | `sim/calendar.ts` (`holidayName`)、`sim/term-machine.ts` (`fireHolidayEvent`)、`sim/world-brain.ts` (`holidayEvent`)、`server/term-loop.ts` |
| プレイヤー裁判介入 | 中央「有罪/無罪」=殺活投票+扇動/沈静化+罵倒/擁護フキダシ。投票し直し可 | `sim/term-machine.ts` (`addUserVote`)、`client/main.ts` |
| push 通知投票 | 裁判が開くと WebPush で離脱中の端末も呼び戻す。`userId` ごと 1 席の重み合算 (WS/HTTP)。VAPID 未設定なら無効 | `server/{push-service,http-api}.ts`、`client/{push-client,public/sw.js}`、spec `interface/notification-voting.md` |

## 観戦UI (client / PixiJS)

| 要素 | 実装 |
|---|---|
| ステージ (村/裁判の2シーン, 毎フレーム自走) | `client/src/stage-view.ts` |
| 村シーン (動物スプライト/うろつき/雑談/事件フォーカス) | `village-scene.ts` / `chatter.ts` / `assets.ts` |
| 裁判シーン (順番に糾弾/やり返し/断末魔, server糾弾優先) | `trial-scene.ts` |
| アニメ吹き出し (1文字ずつ/波/いらだち=大+とげとげ+シェイク) | `animated-bubble.ts` |
| 左=当事者 / 右=村評判+接続数+投票結果 | `incident-panel.ts` / `village-status.ts` / `radar.ts` |
| 右上LLM設定パネル / 📜村の歴史モーダル | `llm-panel.ts` / `chronicle-view.ts` |
| 3カラム + モバイルドロワー + 有罪/無罪ボタン | `index.html` / `main.ts` |
| 動物素材 | Kenney "Animal pack" CC0 (`public/assets/animals/`) |

## env (調整つまみ)

| env | 既定 | 効果 |
|---|---|---|
| `PAGUS_BRAIN` | `stub` | `llm` で実LLM駆動 |
| `PAGUS_DISABLE_CODEX` | (off) | `1` で codex(GPT-5.6 Sol/Terra/Luna) を既定キャストから外す (既定は合流) |
| `PAGUS_CLI_RETRIES` | 2 | CLI (claude/codex) の一過性失敗のリトライ回数 (0 で無効) |
| `PAGUS_RECONCILE` | 0.15 | 和解の基礎確率 |
| `PAGUS_SECONDARY` | 0.18 | 二次被害の確率 |
| `PAGUS_STRESS_K` | 0.06 | ストレス耐性の効き |
| `PAGUS_MARRIAGE` | 0.12 | 日末の結婚確率 |
| `PAGUS_BIRTH` | 0.1 | 日末の出産確率 |
| `PAGUS_WS_PORT` | 4310 | game server WS ポート |
| `PAGUS_FRESH` | (off) | `1` で DB 内の world state を無視し新規開始 |
| `PAGUS_PUSH` | (off) | `1` で WebPush 通知を有効化 (要 VAPID 鍵) |
| `PAGUS_VAPID_PUBLIC` / `PAGUS_VAPID_PRIVATE` / `PAGUS_VAPID_SUBJECT` | — | VAPID 鍵 (秘密)。生成 `npx web-push generate-vapid-keys` |
| `PAGUS_ACCEL` / `PAGUS_MIN_MS` / `PAGUS_INCIDENT_MS` / `PAGUS_REPS` | — | dev のペース/負荷調整 |
| `PAGUS_LOG_STDOUT` / `PAGUS_LOG_FILE` / `PAGUS_LOG_DIR` | on | セッションログ出力 |

client は Vite 4320 (Memoria 5180 と分離)、WS は同一オリジン `/ws` を 4310 へ proxy。

## runtime 永続化 (gitignore)

- `session_log` (SQLite) — セッションログの権威データ。設定時のみ `logs/pagus-*.jsonl` にも追記
- `data/runtime/denunciations.json` — 糾弾レパートリー (成長)
- `data/runtime/pagus.sqlite` — **ゲームデータDB**。world スナップショット、村の歴史、チャット、イベントリプレイ、シーズン履歴を保存する。既存 `world.json` / `chronicle.json` / `chat.json` / `seasons.json` は初回移行元として読む。
- world BLOB は進行中状態だけを持ち、行動履歴と退場住民の関係・信仰は別テーブルへ退避する。
- `data/runtime/push-subscriptions.json` — **WebPush 購読** (endpoint で重複排除)。失効購読は送信時に除去。実装 `server/push-service.ts`。
