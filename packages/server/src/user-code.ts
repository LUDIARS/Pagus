// ユーザーコード = userId (UUIDv4) (§v1.3-F)。別端末ログインの検証と
// 旧セッション追い出しの「蹴る対象選定」を純粋関数に切り出してテスト可能にする。

/** UUID (RFC4122, version 1-5) の形か判定する。crypto.randomUUID() は v4 を返す。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** ユーザーコード (=userId) が妥当な UUID 形式か。空/不正形式は false (§v1.3-F)。 */
export function isValidUserCode(code: string): boolean {
  if (typeof code !== 'string' || code.length === 0) return false;
  return UUID_RE.test(code);
}

/**
 * login 時に蹴るべき他接続を求める (§v1.3-F, 純粋)。
 * connUser から ws 以外で同じ code(userId) にバインドされた接続を集めて返す。
 */
export function connectionsToLogout<T>(connUser: Map<T, string>, ws: T, code: string): T[] {
  const out: T[] = [];
  for (const [other, uid] of connUser) {
    if (other !== ws && uid === code) out.push(other);
  }
  return out;
}
