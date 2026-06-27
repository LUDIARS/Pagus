import { describe, it, expect } from 'vitest';
import { pickVillageRules, DEFAULT_RULE_TEMPLATES } from '../src/index.js';

describe('村のルール抽選 (§8.1)', () => {
  it('重複なく n 件を採番して返す', () => {
    const rules = pickVillageRules(Math.random, 4);
    expect(rules).toHaveLength(4);
    const texts = new Set(rules.map((r) => r.text));
    expect(texts.size).toBe(4); // 重複なし
    expect(rules.map((r) => r.id)).toEqual(['rule_1', 'rule_2', 'rule_3', 'rule_4']);
    for (const r of rules) expect(DEFAULT_RULE_TEMPLATES).toContain(r.text);
  });

  it('テンプレ数を超える要求はテンプレ全件で頭打ち', () => {
    const rules = pickVillageRules(Math.random, 999);
    expect(rules).toHaveLength(DEFAULT_RULE_TEMPLATES.length);
    expect(new Set(rules.map((r) => r.text)).size).toBe(DEFAULT_RULE_TEMPLATES.length);
  });

  it('決定的 rng で再現する', () => {
    const seq = [0.1, 0.5, 0.9, 0.0];
    let i = 0;
    const rng = (): number => seq[i++ % seq.length] ?? 0;
    const a = pickVillageRules(rng, 3);
    i = 0;
    const b = pickVillageRules(rng, 3);
    expect(a).toEqual(b);
  });
});
