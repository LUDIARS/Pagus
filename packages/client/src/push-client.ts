// 接続ユーザの識別子と WebPush 購読 (§4.8)。
// userId は投票の重み合算/投票し直しの単位として server に渡す。

const UID_KEY = 'pagus_uid';

/** この端末の安定したユーザ ID (localStorage 永続)。投票に添える。既存値が無ければ UUIDv4 を発行。 */
export function getUserId(): string {
  let id = localStorage.getItem(UID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(UID_KEY, id);
  }
  return id;
}

/** 別端末ログイン (§v1.3-F): userId をユーザーコードへ差し替えて永続化する。 */
export function setUserId(id: string): void {
  localStorage.setItem(UID_KEY, id);
}

/** VAPID 公開鍵 (base64url) を applicationServerKey 用の Uint8Array へ。 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * WebPush を有効化する。SW 登録 → 公開鍵取得 → 通知許可 → 購読 → server へ登録。
 * 成功でボタン表示用の文言を返す。各段階の失敗は throw (無言フォールバックしない)。
 */
export async function enablePush(): Promise<string> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('この端末は通知に非対応');
  }
  const info = (await (await fetch('/api/push/public-key')).json()) as { enabled: boolean; key?: string };
  if (!info.enabled || !info.key) throw new Error('サーバの通知が無効');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知が許可されませんでした');

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(info.key),
  });
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub),
  });
  if (!res.ok) throw new Error('購読の登録に失敗');
  return '🔔 通知ON';
}
