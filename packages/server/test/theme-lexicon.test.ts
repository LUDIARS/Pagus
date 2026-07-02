import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadLexicon, validateMoral } from '../src/theme/lexicon.js';

const here = dirname(fileURLToPath(import.meta.url));
/** リポ正本の data/ (コミット済みの classic / spirit-forest を検証対象にする)。 */
const DATA = resolve(here, '../../../data');

describe('テーマパック (§v1.4-D lexicon)', () => {
  it('classic が全キー揃いでロードできる', () => {
    const lex = loadLexicon('classic', 'balanced', DATA);
    expect(lex.packName).toBe('クラシック');
    expect(lex.verdictDeathJa).toBe('死刑');
    expect(lex.taunts.length).toBeGreaterThan(0);
    expect(lex.denounceSeeds.length).toBeGreaterThan(0);
  });

  it('spirit-forest が全キー揃いでロードできる (儀式語彙)', () => {
    const lex = loadLexicon('spirit-forest', 'balanced', DATA);
    expect(lex.trialOpen).toBe('禊の儀');
    expect(lex.verdictDeathJa).toBe('森に還す');
    expect(lex.denounceTone).toContain('穢れ');
  });

  it('moral=wholesome で wholesome 上書きがマージされる', () => {
    const base = loadLexicon('classic', 'balanced', DATA);
    const soft = loadLexicon('classic', 'wholesome', DATA);
    expect(base.giftPoisonLabel).toBe('☠ 毒饅頭');
    expect(soft.giftPoisonLabel).toBe('🍭 イタズラ菓子');
    expect(soft.trialOpen).toBe(base.trialOpen); // 上書きされないキーは据え置き
  });

  it('キー欠落のパックは即エラー (無言フォールバック禁止)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'pagus-theme-'));
    mkdirSync(resolve(dir, 'theme', 'broken'), { recursive: true });
    writeFileSync(resolve(dir, 'theme', 'broken', 'lexicon.json'), JSON.stringify({ packName: '壊' }));
    expect(() => loadLexicon('broken', 'balanced', dir)).toThrow(/必須キー/);
  });

  it('存在しないパック・不正なパック名は即エラー', () => {
    expect(() => loadLexicon('no-such-pack', 'balanced', DATA)).toThrow(/読めません/);
    expect(() => loadLexicon('../etc', 'balanced', DATA)).toThrow(/不正/);
  });

  it('validateMoral は enum 以外を弾く', () => {
    expect(validateMoral('wholesome')).toBe('wholesome');
    expect(() => validateMoral('spicy')).toThrow();
  });
});
