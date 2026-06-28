import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isValidUserCode, connectionsToLogout } from '../src/user-code.js';

// ユーザーコード / 別端末ログイン (§v1.3-F)。
describe('isValidUserCode (§v1.3-F ユーザーコード検証)', () => {
  it('crypto.randomUUID() (UUIDv4) は妥当', () => {
    for (let i = 0; i < 20; i += 1) expect(isValidUserCode(randomUUID())).toBe(true);
  });

  it('空文字 / 空白 / 不正形式は弾く (無言フォールバック禁止)', () => {
    expect(isValidUserCode('')).toBe(false);
    expect(isValidUserCode('   ')).toBe(false);
    expect(isValidUserCode('not-a-uuid')).toBe(false);
    expect(isValidUserCode('12345678-1234-1234-1234-1234567890')).toBe(false); // 桁不足
    expect(isValidUserCode('zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz')).toBe(false); // 非 hex
  });

  it('大文字小文字どちらの UUID も許容', () => {
    const id = randomUUID();
    expect(isValidUserCode(id.toUpperCase())).toBe(true);
  });
});

describe('connectionsToLogout (§v1.3-F 旧セッション追い出し)', () => {
  it('同じ userId にバインドされた他接続だけを蹴る対象に返す', () => {
    const conn = new Map<string, string>([
      ['wsA', 'user1'],
      ['wsB', 'user1'], // 同 userId の旧接続
      ['wsC', 'user2'], // 別 userId
    ]);
    // wsA が user1 でログイン → wsB だけ蹴る (自分 wsA と別 userId wsC は対象外)。
    expect(connectionsToLogout(conn, 'wsA', 'user1')).toEqual(['wsB']);
  });

  it('複数の旧接続をすべて返す', () => {
    const conn = new Map<string, string>([
      ['wsA', 'user1'],
      ['wsB', 'user1'],
      ['wsC', 'user1'],
    ]);
    expect(connectionsToLogout(conn, 'wsA', 'user1').sort()).toEqual(['wsB', 'wsC']);
  });

  it('同 userId の他接続が無ければ空 (蹴る相手なし)', () => {
    const conn = new Map<string, string>([
      ['wsA', 'user1'],
      ['wsC', 'user2'],
    ]);
    expect(connectionsToLogout(conn, 'wsA', 'user1')).toEqual([]);
  });
});
