import { describe, it, expect } from 'vitest';
import {
  pickVillageRules,
  DEFAULT_RULE_TEMPLATES,
  addVillageRule,
  removeVillageRule,
  createWorld,
  DEFAULT_CONFIG,
} from '../src/index.js';

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

describe('村ルールの追加/削除 (§2 しきたり改定)', () => {
  it('addVillageRule は既存 rule_N と衝突しない id を採番して追加する', () => {
    const world = createWorld([], DEFAULT_CONFIG, { year: 2026, month: 6 }, pickVillageRules(() => 0, 3));
    expect(world.villageRules.map((r) => r.id)).toEqual(['rule_1', 'rule_2', 'rule_3']);
    const added = addVillageRule(world, '新しい掟');
    expect(added).not.toBeNull();
    expect(added?.id).toBe('vrule_4'); // 既存末尾数値 (3) +1、prefix で衝突回避
    expect(added?.text).toBe('新しい掟');
    expect(world.villageRules).toHaveLength(4);
    // さらに追加すると 5 (既存 vrule_4 の末尾 +1)。
    expect(addVillageRule(world, 'もう一つ')?.id).toBe('vrule_5');
  });

  it('addVillageRule は maxRules 到達時に null を返す (無言フォールバックなし)', () => {
    const world = createWorld([], DEFAULT_CONFIG, { year: 2026, month: 6 }, pickVillageRules(() => 0, 3));
    expect(addVillageRule(world, 'ok', 4)).not.toBeNull(); // 3 → 4
    expect(world.villageRules).toHaveLength(4);
    expect(addVillageRule(world, 'over', 4)).toBeNull(); // 上限
    expect(world.villageRules).toHaveLength(4);
  });

  it('removeVillageRule は存在する id を消し、無い id では false', () => {
    const world = createWorld([], DEFAULT_CONFIG, { year: 2026, month: 6 }, pickVillageRules(() => 0, 2));
    expect(removeVillageRule(world, 'rule_1')).toBe(true);
    expect(world.villageRules.map((r) => r.id)).toEqual(['rule_2']);
    expect(removeVillageRule(world, 'nope')).toBe(false);
    expect(world.villageRules).toHaveLength(1);
  });

  it('削除後の再追加でも id が衝突しない (空でも採番できる)', () => {
    const world = createWorld([], DEFAULT_CONFIG, { year: 2026, month: 6 }, []);
    const a = addVillageRule(world, 'a');
    expect(a?.id).toBe('vrule_1'); // 空なら 1 始まり
    removeVillageRule(world, 'vrule_1');
    expect(world.villageRules).toHaveLength(0);
    expect(addVillageRule(world, 'b')?.id).toBe('vrule_1'); // 空に戻れば再び 1
  });
});
