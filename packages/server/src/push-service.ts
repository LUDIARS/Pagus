// WebPush 通知 (§4.8)。裁判など投票が要る局面で、接続を閉じていても
// 端末へ通知を飛ばす。VAPID 鍵は秘密なので暗号化 config (PagusConfig.push) から受け、
// 未設定なら無効 (enabled なのに鍵が無ければ即エラー = 無言フォールバック禁止)。
// 購読は data/runtime/push-subscriptions.json に永続化する (gitignore)。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import webpush, { type PushSubscription } from 'web-push';
import { dataDir } from './load-data.js';

/** PushService の設定 (PagusConfig.push 相当)。 */
export interface PushServiceConfig {
  /** push 通知を有効化するか。 */
  enabled: boolean;
  /** VAPID 公開鍵 (秘密)。空=未設定。 */
  vapidPublic: string;
  /** VAPID 秘密鍵 (秘密)。空=未設定。 */
  vapidPrivate: string;
  /** VAPID subject。 */
  vapidSubject: string;
}

/** 通知ペイロード (service worker が showNotification に使う)。 */
export interface PushPayload {
  title: string;
  body: string;
  /** クリックで開く URL (既定はルート)。 */
  url?: string;
}

export class PushService {
  private readonly enabled: boolean;
  private readonly publicKey: string | null;
  private readonly path: string;
  private subscriptions: PushSubscription[];

  constructor(config: PushServiceConfig) {
    this.path = resolve(dataDir(), 'runtime', 'push-subscriptions.json');
    this.enabled = config.enabled;

    if (!this.enabled) {
      this.publicKey = null;
      this.subscriptions = [];
      console.log('[pagus] push 通知は無効 (config push.enabled=true + VAPID 鍵で有効化)');
      return;
    }

    const pub = config.vapidPublic;
    const priv = config.vapidPrivate;
    const subject = config.vapidSubject.length > 0 ? config.vapidSubject : 'mailto:pagus@vtn-game.com';
    if (!pub || !priv) {
      // 有効化を指示したのに鍵が無い = 設定不備 → 即エラー (RULE_CODE §7.1)。
      throw new Error(
        'push.enabled=true だが VAPID 鍵が未設定。config の push.vapidPublic / push.vapidPrivate を設定せよ ' +
          '(生成: npx web-push generate-vapid-keys → pnpm pagus:config set)',
      );
    }
    webpush.setVapidDetails(subject, pub, priv);
    this.publicKey = pub;
    this.subscriptions = this.load();
    console.log(`[pagus] push 通知 有効 (購読 ${this.subscriptions.length} 件)`);
  }

  /** クライアントへ渡す VAPID 公開鍵 (無効なら null)。 */
  getPublicKey(): string | null {
    return this.publicKey;
  }

  /** 購読を登録 (endpoint で重複排除) して永続化する。 */
  subscribe(sub: PushSubscription): void {
    if (!this.enabled) return;
    if (this.subscriptions.some((s) => s.endpoint === sub.endpoint)) return;
    this.subscriptions.push(sub);
    this.save();
  }

  /** 全購読へ通知を送る。失効した購読 (404/410) は取り除く。 */
  async notifyAll(payload: PushPayload): Promise<void> {
    if (!this.enabled || this.subscriptions.length === 0) return;
    const body = JSON.stringify(payload);
    const dead: string[] = [];
    await Promise.all(
      this.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, body);
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) dead.push(sub.endpoint);
          else console.error('[pagus] push 送信失敗', code ?? e);
        }
      }),
    );
    if (dead.length > 0) {
      this.subscriptions = this.subscriptions.filter((s) => !dead.includes(s.endpoint));
      this.save();
    }
  }

  private load(): PushSubscription[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        return raw.filter(
          (s): s is PushSubscription =>
            typeof s === 'object' && s !== null && typeof (s as PushSubscription).endpoint === 'string',
        );
      }
    } catch {
      /* 無ければ空で始める */
    }
    return [];
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.subscriptions, null, 2), 'utf8');
    } catch (e) {
      console.error('[pagus] push 購読の保存失敗', e);
    }
  }
}
