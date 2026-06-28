import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig } from '@ludiars/encrypted-config';
import {
  DEFAULT_CONFIG,
  STORE_OPTIONS,
  loadPagusConfig,
  mergePagusConfig,
  flattenConfig,
  coerceLeaf,
  storeEnv,
} from '../src/config/pagus-config.js';

// 一時ファイルで実 data/ を汚さずに検証する (@ludiars/encrypted-config 経由)。
let dir: string;
let cfgPath: string;
const MASTER = 'test-master-secret-12345';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pagus-config-test-'));
  cfgPath = join(dir, 'pagus.config.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** tmp config パス + master を載せた env で 1 キー保存する。 */
function set(key: string, value: string): void {
  setConfig(key, value, STORE_OPTIONS, storeEnv({ configPath: cfgPath, masterKey: MASTER }));
}
function load() {
  return loadPagusConfig({ configPath: cfgPath, masterKey: MASTER });
}

describe('mergePagusConfig (部分 nested を defaults へ deep merge)', () => {
  it('部分指定は defaults に重なり、未指定は既定値のまま', () => {
    const cfg = mergePagusConfig({ karma: { rate: 2 }, server: { wsPort: 9999 } });
    expect(cfg.karma.rate).toBe(2);
    expect(cfg.karma.max).toBe(DEFAULT_CONFIG.karma.max);
    expect(cfg.server.wsPort).toBe(9999);
    expect(cfg.sim.triggerAfter).toBe(DEFAULT_CONFIG.sim.triggerAfter);
  });

  it('型不一致は throw (無言フォールバック禁止)', () => {
    expect(() => mergePagusConfig({ karma: { rate: 'fast' } })).toThrow();
    expect(() => mergePagusConfig({ server: { logStdout: 1 } })).toThrow();
    expect(() => mergePagusConfig({ economy: { topupPacks: 100 } })).toThrow();
  });

  it('不明キーは warn して無視する', () => {
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

describe('flattenConfig / coerceLeaf (dot-path ⇄ 文字列)', () => {
  it('DEFAULT_CONFIG を dot-key の文字列 map に畳む', () => {
    const flat = flattenConfig(DEFAULT_CONFIG);
    expect(flat['karma.rate']).toBe('0.5');
    expect(flat['server.logStdout']).toBe('true');
    expect(flat['economy.topupPacks']).toBe('[100,500,1000]'); // 配列は JSON 文字列
  });

  it('coerceLeaf は dot-path の既定型に合わせて変換し、不正は throw', () => {
    expect(coerceLeaf('karma.rate', '0.9')).toBe(0.9);
    expect(coerceLeaf('server.logStdout', 'false')).toBe(false);
    expect(coerceLeaf('economy.topupPacks', '[5,10]')).toEqual([5, 10]);
    expect(() => coerceLeaf('karma.rate', 'fast')).toThrow();
    expect(() => coerceLeaf('server.logStdout', 'yes')).toThrow();
  });
});

describe('loadPagusConfig (@ludiars/encrypted-config 経由)', () => {
  it('ファイルが無ければ defaults を返して warn する (劣化フォールバックではない)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(load()).toEqual(DEFAULT_CONFIG);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('保存したキーを型変換して defaults へ merge する', () => {
    set('karma.rate', '3');
    set('server.wsPort', '9999');
    const cfg = load();
    expect(cfg.karma.rate).toBe(3);
    expect(cfg.server.wsPort).toBe(9999);
    expect(cfg.karma.max).toBe(DEFAULT_CONFIG.karma.max); // 未指定は既定
  });

  it('VAPID 秘密鍵は secrets として暗号化保存される (ファイルに平文で出ない)', () => {
    set('push.vapidPrivate', 'super-secret-key');
    const onDisk = readFileSync(cfgPath, 'utf8');
    expect(onDisk).not.toContain('super-secret-key'); // 平文で出ない
    expect(onDisk).toContain('secrets'); // EncryptedBlob として格納
    expect(load().push.vapidPrivate).toBe('super-secret-key'); // 復号して読める
  });

  it('master secret が違うと secrets は復号できず欠落する (= 既定値のまま)', () => {
    set('push.vapidPrivate', 'k');
    const cfg = loadPagusConfig({ configPath: cfgPath, masterKey: 'WRONG-master' });
    expect(cfg.push.vapidPrivate).toBe(DEFAULT_CONFIG.push.vapidPrivate); // 復号失敗キーは skip
  });

  it('保存値が型不正なら load で throw (無言フォールバック禁止)', () => {
    // 数値キーに非数値文字列を直接保存しておく。
    set('karma.rate', 'not-a-number');
    expect(() => load()).toThrow();
  });

  it('config ファイルが実際に生成される', () => {
    set('karma.rate', '1');
    expect(existsSync(cfgPath)).toBe(true);
  });
});
