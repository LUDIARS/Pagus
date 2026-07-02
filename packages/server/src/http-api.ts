// game server の HTTP API。WS と同じポートに相乗りする (同一オリジン)。
// - GET  /api/push/public-key  VAPID 公開鍵 (push 無効なら enabled:false)
// - POST /api/push/subscribe   購読登録 (body = PushSubscription)
// - POST /api/vote             裁判への 1 票 ({pick, userId}) — 通知経由の投票用
// - GET  /api/blackbox/rules            判例ルール一覧 + 卒業メトリクス
// - GET  /api/blackbox/decisions        判例のレビュー待ちキュー (trial 発火分)
// - POST /api/blackbox/decisions/:id/verdict  {verdict: "ok"|"ng"} — OK×3 で判例卒業
// - GET  /healthz              死活
// それ以外は 404。WS の upgrade は ws 側が処理するのでここには来ない。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PushSubscription } from 'web-push';
import { describeCondition, type BlackBox } from '@ludiars/blackbox';
import { DOMAIN_TRIAL_FATE } from './llm/fate-blackbox.js';
import type { PushService } from './push-service.js';

export interface HttpApiDeps {
  push: PushService;
  /** 裁判への 1 票を反映する。 */
  onVote(pick: string, userId: string): void;
  /** 裁判判例の成長型ブラックボックス (レビュー/閲覧用)。 */
  blackbox?: BlackBox;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large'); // 過大な POST を拒否
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createRequestListener(deps: HttpApiDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    if (method === 'GET' && url === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && url === '/api/push/public-key') {
      const key = deps.push.getPublicKey();
      sendJson(res, 200, key ? { enabled: true, key } : { enabled: false });
      return;
    }

    if (method === 'POST' && url === '/api/push/subscribe') {
      void readJson(req)
        .then((body) => {
          const sub = body as PushSubscription;
          if (!sub || typeof sub.endpoint !== 'string') {
            sendJson(res, 400, { error: 'invalid subscription' });
            return;
          }
          deps.push.subscribe(sub);
          sendJson(res, 201, { ok: true });
        })
        .catch(() => sendJson(res, 400, { error: 'bad request' }));
      return;
    }

    if (deps.blackbox && method === 'GET' && url === '/api/blackbox/rules') {
      const bb = deps.blackbox;
      const rules = bb.engine.listRules(DOMAIN_TRIAL_FATE).map((r) => ({
        ...r,
        whenText: describeCondition(r.when),
      }));
      sendJson(res, 200, { rules, stats: bb.stats(DOMAIN_TRIAL_FATE) });
      return;
    }

    if (deps.blackbox && method === 'GET' && url === '/api/blackbox/decisions') {
      sendJson(res, 200, { items: deps.blackbox.ledger.listPending(DOMAIN_TRIAL_FATE, 50) });
      return;
    }

    if (deps.blackbox && method === 'POST' && /^\/api\/blackbox\/decisions\/\d+\/verdict$/.test(url)) {
      const bb = deps.blackbox;
      const id = Number(url.split('/')[4]);
      void readJson(req)
        .then((body) => {
          const v = (body as { verdict?: unknown }).verdict;
          if (v !== 'ok' && v !== 'ng') {
            sendJson(res, 400, { error: "verdict must be 'ok' or 'ng'" });
            return;
          }
          const r = bb.engine.recordVerdict(id, v);
          if (!r.ok) {
            sendJson(res, 404, { error: 'decision not found' });
            return;
          }
          sendJson(res, 200, { ok: true, rule: r.ruleUpdated ?? null });
        })
        .catch(() => sendJson(res, 400, { error: 'bad request' }));
      return;
    }

    if (method === 'POST' && url === '/api/vote') {
      void readJson(req)
        .then((body) => {
          const b = body as { pick?: unknown; userId?: unknown };
          if (typeof b.pick !== 'string') {
            sendJson(res, 400, { error: 'pick required' });
            return;
          }
          const userId = typeof b.userId === 'string' && b.userId.length > 0 ? b.userId : 'anon';
          deps.onVote(b.pick, userId);
          sendJson(res, 200, { ok: true });
        })
        .catch(() => sendJson(res, 400, { error: 'bad request' }));
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  };
}
