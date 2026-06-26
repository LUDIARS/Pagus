# 通知投票 (WebPush) — インターフェース仕様

> SPEC §4.8 / §8B.4 の確定形。2026-06-26 起草 (v0.6 実装)。
> 裁判など「ユーザ確認が要る局面」で、接続を閉じた端末も含めて通知し、投票を促す。

## 目的

観戦タブを閉じていても裁判の到来に気づき、投票で事件・裁判の分岐に関与できるようにする。
住民 bloc 投票 (グループ人数の重み) に、接続ユーザの票 (`userId` ごと重み 1) を**合算**する。

## userId (投票の単位)

- client は `localStorage['pagus_uid']` に `crypto.randomUUID()` を保存し、安定 ID とする (`client/push-client.ts`)。
- 投票 (WS `vote` / HTTP `/api/vote`) に `userId` を添える。
- server (`sim/TermMachine.addUserVote(pick, userId)`) は **userId ごとに 1 席**を持たせる:
  - 別 userId の票は集計に**加算** (重み合算)。
  - 同 userId が同段階で投票し直したら、**自分の前票だけ**取り消して差し替える。
  - `userId` 省略時は単独ローカル観戦者 `'local'`。

## HTTP API (game server, WS と同一ポート 4310)

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/healthz` | 死活 (`{ok:true}`) |
| `GET` | `/api/push/public-key` | VAPID 公開鍵。push 無効なら `{enabled:false}`、有効なら `{enabled:true, key}` |
| `POST` | `/api/push/subscribe` | body = `PushSubscription` (JSON)。endpoint で重複排除し永続化 |
| `POST` | `/api/vote` | body = `{pick, userId}`。通知クリック後の投票用。`pick` = 候補id or `kill`/`spare` |

client は同一オリジン `/api/*` を Vite proxy (dev) / Cloudflare Tunnel (本番) 経由で 4310 へ。

## WebPush フロー

1. client: `🔔 通知` ボタン → `enablePush()`:
   - `GET /api/push/public-key` → 無効なら中断。
   - `Notification.requestPermission()` → 拒否なら中断 (無言フォールバックしない、ボタンに理由表示)。
   - `navigator.serviceWorker.register('/sw.js')` → `pushManager.subscribe({userVisibleOnly, applicationServerKey})`。
   - `POST /api/push/subscribe` で購読を server へ。
2. server: 裁判が開く (`onTrialOpen`) と `PushService.notifyAll({title, body, url})`。失効購読 (404/410) は除去。
3. `public/sw.js`: `push` で `showNotification` (tag で上書き)、`notificationclick` で観戦タブを focus/open。

## 永続化 / 設定 (env)

- 購読: `data/runtime/push-subscriptions.json` (gitignore)。
- `PAGUS_PUSH=1` で有効化。`PAGUS_VAPID_PUBLIC` / `PAGUS_VAPID_PRIVATE` (秘密) / `PAGUS_VAPID_SUBJECT` (既定 `mailto:pagus@vtn-game.com`)。
- 鍵生成: `npx web-push generate-vapid-keys`。**`PAGUS_PUSH=1` で鍵が無ければ即エラー** (RULE_CODE §7.1)。
- 既定 (env 未設定) は push 無効。`/api/push/public-key` が `{enabled:false}` を返し client はボタンで「サーバの通知が無効」を表示。

## 実装ファイル

- server: `push-service.ts` (VAPID/購読/通知) / `http-api.ts` (ルーティング) / `ws-server.ts` (HTTP に相乗り) / `index.ts` (配線・onTrialOpen 通知)。
- sim: `term-machine.ts` (`addUserVote` per-user) / `types/trial.ts` (`VoteRecord.userId`) / `protocol.ts` (`vote.userId`)。
- client: `push-client.ts` / `public/sw.js` / `main.ts` (🔔 ボタン・userId 付き投票)。
