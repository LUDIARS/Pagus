import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretBox, resolveSecretKey, isEncrypted } from '../src/config/secret-box.js';
import {
  DEFAULT_CONFIG,
  loadPagusConfig,
  mergePagusConfig,
} from '../src/config/pagus-config.js';

// 一時ディレクトリで実 data/ を汚さずに検証する。
let dir: string;
const ENV_KEY = 'test-passphrase-12345';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pagus-config-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** ENV_KEY 由来の決定的な鍵で SecretBox を作る (keyFile は使わない)。 */
function boxForEnvKey(): SecretBox {
  return new SecretBox(resolveSecretKey({ envValue: ENV_KEY, keyFile: join(dir, 'unused.key') }));
}

describe('SecretBox (AES-256-GCM at-rest)', () => {
  it('encrypt → decrypt で平文に戻る (enc:v1 形式)', () => {
    const box = boxForEnvKey();
    const enc = box.encrypt('秘密の VAPID 鍵');
    expect(isEncrypted(enc)).toBe(true);
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(box.decrypt(enc)).toBe('秘密の VAPID 鍵');
  });

  it('改竄された ciphertext は復号で throw する (GCM 認証)', () => {
    const box = boxForEnvKey();
    const enc = box.encrypt('original');
    // ciphertext 末尾を 1 文字いじる (base64 を壊さない範囲で別文字へ)。
    const last = enc.slice(-1);
    const tampered = enc.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(() => box.decrypt(tampered)).toThrow();
  });

  it('別の鍵では復号できない (throw)', () => {
    const a = new SecretBox(resolveSecretKey({ envValue: 'key-a', keyFile: join(dir, 'a.key') }));
    const b = new SecretBox(resolveSecretKey({ envValue: 'key-b', keyFile: join(dir, 'b.key') }));
    expect(() => b.decrypt(a.encrypt('msg'))).toThrow();
  });
});

describe('mergePagusConfig (部分 JSON を defaults へ deep merge)', () => {
  it('部分指定は defaults に重なり、未指定は既定値のまま', () => {
    const cfg = mergePagusConfig({ karma: { rate: 2 }, server: { wsPort: 9999 } });
    expect(cfg.karma.rate).toBe(2); // 上書き
    expect(cfg.karma.max).toBe(DEFAULT_CONFIG.karma.max); // 既定維持
    expect(cfg.server.wsPort).toBe(9999);
    expect(cfg.sim.triggerAfter).toBe(DEFAULT_CONFIG.sim.triggerAfter);
  });

  it('型不一致は throw (無言フォールバック禁止)', () => {
    expect(() => mergePagusConfig({ karma: { rate: 'fast' } })).toThrow();
    expect(() => mergePagusConfig({ server: { logStdout: 1 } })).toThrow();
    expect(() => mergePagusConfig({ economy: { topupPacks: 100 } })).toThrow();
  });

  it('不明キーは warn して無視する (throw しない)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = mergePagusConfig({ karma: { bogus: 1 }, nope: {} });
    expect(cfg.karma.rate).toBe(DEFAULT_CONFIG.karma.rate);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('配列 (topupPacks) は要素型を検証し受理する', () => {
    expect(mergePagusConfig({ economy: { topupPacks: [10, 20] } }).economy.topupPacks).toEqual([10, 20]);
    expect(() => mergePagusConfig({ economy: { topupPacks: ['a'] } })).toThrow();
  });
});

describe('loadPagusConfig (暗号化ファイル)', () => {
  it('ファイルがあれば復号して defaults へ merge する', () => {
    const encFile = join(dir, 'pagus.config.enc');
    const box = boxForEnvKey();
    writeFileSync(encFile, box.encrypt(JSON.stringify({ karma: { rate: 3 }, push: { enabled: true } })), 'utf8');
    const cfg = loadPagusConfig({ encFile, keyFile: join(dir, 'k.key'), envKey: ENV_KEY });
    expect(cfg.karma.rate).toBe(3);
    expect(cfg.push.enabled).toBe(true);
    expect(cfg.karma.max).toBe(DEFAULT_CONFIG.karma.max); // 未指定は既定
  });

  it('復号できる JSON が型不正なら throw', () => {
    const encFile = join(dir, 'pagus.config.enc');
    writeFileSync(encFile, boxForEnvKey().encrypt(JSON.stringify({ karma: { rate: 'x' } })), 'utf8');
    expect(() => loadPagusConfig({ encFile, keyFile: join(dir, 'k.key'), envKey: ENV_KEY })).toThrow();
  });

  it('復号後が JSON でないなら throw', () => {
    const encFile = join(dir, 'pagus.config.enc');
    writeFileSync(encFile, boxForEnvKey().encrypt('not json at all'), 'utf8');
    expect(() => loadPagusConfig({ encFile, keyFile: join(dir, 'k.key'), envKey: ENV_KEY })).toThrow();
  });

  it('ファイルが無ければ defaults を返して warn する (劣化フォールバックではない)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadPagusConfig({ encFile: join(dir, 'absent.enc'), keyFile: join(dir, 'k.key'), envKey: ENV_KEY });
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
