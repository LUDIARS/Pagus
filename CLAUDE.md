# Pagus — Claude 向けメモ

LUDIARS の AI 村シミュレーション。略称 **Pa**。Notion 企画「AI村を作ろう」が正本企画。

## これは何か

LLM 駆動で村人が自律行動し、事件 → 裁判 → 教育(改変) を繰り返す創発シミュレーション。
「シムズを超える」AI 感の実験。研究/ゼミ用プロトタイプとして **AI ループの反復速度** を最優先。

## 構成 (pnpm monorepo)

| パッケージ | 役割 |
|---|---|
| `@pagus/sim` | 純 TS シミュレーション核。村人ペルソナ / 起承転結ステートマシン / 事件system / 環境grid。LLM・描画非依存 = テスト可。`Brain` を DI |
| `@pagus/server` | Node 権威サーバ。sim を駆動・`claude -p` で `Brain` 実装 (`@ludiars/llm-gateway` 消費)・WS API |
| `@pagus/client` | Vite + PixiJS。2D トップダウン村 + 事件フィード / 裁判 UI / 扇動・沈静化操作 |

## 重要原則

- **環境 = プログラム / 感情 = AI / 情報 = 蓄積** の三分。型レベルで分離 (`spec/SPEC.md`)。
- **sim は LLM/描画を知らない**。`Brain` interface 越しにのみ AI を呼ぶ → stub で決定的にテスト。
- LLM は **API 不使用 = `claude -p` CLI** (LUDIARS 規約)。tier は `@ludiars/llm-gateway` の `pickTier`:
  tick/感情 = cheap(Haiku)、承GANs/裁判/教育 = strong(Sonnet/Opus)。
- 設定不備の**無言フォールバック禁止** = 即エラー (RULE_CODE §7.1)。

## branch 運用

- substantive な編集は `feat/` ブランチ + PR (main 直編集しない)。AI 実装は 1 PR 集約。
- Ars 配下なので CI green ならオートマージ (squash+delete) 可。

## 関連

- 企画正本: Notion「AI村を作ろう」(開発ゼミ 研究テーマ配下)
- 設計正本: `spec/SPEC.md`
- LLM 整形: `@ludiars/llm-gateway` (Lapilli)
