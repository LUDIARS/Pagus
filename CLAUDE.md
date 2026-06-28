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
- LLM は **API 不使用 = CLI** (LUDIARS 規約)。claude=`claude -p`、GPT-5.5=`codex exec`。tier は `@ludiars/llm-gateway` の `pickTier`: tick/感情 = cheap(Haiku)、承GANs/裁判/教育 = strong(Sonnet/Opus)。
  - **codex(gpt-5.5) は既定キャストに合流済**。一過性 `exit 1` (codex Stop hook 由来等) は CLI レベルのリトライ (`PAGUS_CLI_RETRIES` 既定2) で吸収。`PAGUS_DISABLE_CODEX=1` で外せる。
- 設定不備の**無言フォールバック禁止** = 即エラー (RULE_CODE §7.1)。

## 起動 / 観戦 (実装済)

- game server: `PAGUS_BRAIN=llm node packages/server/dist/index.js` → WS **4310**。`stub` で決定的観戦。
- client: `pnpm --filter @pagus/client dev` → **4320** (Memoria 5180 と分離)。WS は同一オリジン `/ws` を 4310 へ proxy (Tunnel 対応)。
- 設定 (暗号化 config): チューニング値 (和解/二次被害/カルマ/カード/経済/政治/演出…) と秘密 (VAPID) は **LUDIARS 正本の共有パッケージ `@ludiars/encrypted-config` (Lapilli, AES-256-GCM + scrypt)** による単一 config に集約する (旧 `PAGUS_*` env ~70 個を統合、ローダ実装 = `server/src/config/`)。形式は `{ plain: {<dotkey>: 文字列}, secrets: {<dotkey>: EncryptedBlob} }`: 非シークレットは dot-path キー (例 `karma.rate`) で**平文**、VAPID 秘密鍵 (`push.vapidPrivate`) だけ暗号化。`pnpm pagus:config init` で `data/runtime/pagus.config.json` を既定値から作成し、`pnpm pagus:config set <dotpath> <value>`(例 `karma.rate 0.9`)/`show`/`import <file.json>` で編集する。**master secret は env `PAGUS_MASTER_KEY`、無ければマシン束縛値 `pagus:hostname:user`** (別マシンへ持ち出すなら `PAGUS_MASTER_KEY` を共有)。config ファイルはコミットしない (`data/runtime/` gitignore)。スキーマ参考は平文 `data/config/pagus.config.example.json`。config が無ければ既定値で起動し warn (型不正は fail-fast で throw)。値の env フォールバックは撤去済。
  - env のまま残す例外 (launch/operational): `PAGUS_MASTER_KEY`(マスター鍵) / `PAGUS_CONFIG_PATH`(config パス override) / `PAGUS_FRESH`(その起動だけ world.json 無視) / `PAGUS_BRAIN`(stub|llm 起動モード) / `PAGUS_DATA_DIR`(config 自体の置き場解決)。
- 永続化: world スナップショットは `data/runtime/world.json` (どうぶつ状態・評判・暦・進行中の事件/裁判を JSON 保存→再起動で復元、`server/world-store.ts`)。WebPush 購読は `data/runtime/push-subscriptions.json`。
- 通知投票 (§4.8): 裁判が開くと接続を閉じた端末へ WebPush。`userId` ごと 1 席の重み合算投票 (WS / HTTP `/api/vote`)。VAPID 鍵は秘密で暗号化 config (`push.vapidPublic/vapidPrivate`) から、未設定時は push 無効 (`push.enabled=true` で鍵欠落なら即エラー)。`server/{push-service,http-api}.ts` / `client/{push-client,public/sw.js}`。
- 創発・生活メカニクスと観戦UIの仕様は `spec/SPEC.md` §5.3 / §6 / §8B、実装索引は `spec/feature/emergent-and-life.md`。

## branch 運用

- substantive な編集は `feat/` ブランチ + PR (main 直編集しない)。AI 実装は 1 PR 集約。
- Ars 配下なので CI green ならオートマージ (squash+delete) 可。

## 関連

- 企画正本: Notion「AI村を作ろう」(開発ゼミ 研究テーマ配下)
- 設計正本: `spec/SPEC.md`
- LLM 整形: `@ludiars/llm-gateway` (Lapilli)
