import { describe, it, expect } from 'vitest';
import {
  createVillager,
  createWorld,
  resolveItemKind,
  applyItemEffect,
  collectItems,
  DEFAULT_ITEMS,
  DRUG_TAG,
  TermMachine,
  StubBrain,
  evaluateRules,
  defaultBehaviorRules,
} from '../src/index.js';
import type { Villager } from '../src/index.js';
import type { EnvironmentView } from '../src/brain.js';

function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}
function vAt(id: string, x: number, y: number): Villager {
  const v = createVillager({ id, name: id, position: { x, y } });
  v.wealth = 100;
  return v;
}

describe('フィールドアイテム (§16)', () => {
  it("resolveItemKind: random は rng で precious/drug、指定はそのまま", () => {
    expect(resolveItemKind('random', () => 0.1)).toBe('precious');
    expect(resolveItemKind('random', () => 0.9)).toBe('drug');
    expect(resolveItemKind('precious', () => 0.9)).toBe('precious');
    expect(resolveItemKind('drug', () => 0.1)).toBe('drug');
  });

  it('貴金属を拾うと富む', () => {
    const v = vAt('a', 0, 0);
    applyItemEffect(v, 'precious');
    expect(v.wealth).toBe(100 + DEFAULT_ITEMS.preciousWealth);
  });

  it('薬物を拾うと怒りが上がり所持金が減り依存タグが積む', () => {
    const v = vAt('a', 0, 0);
    applyItemEffect(v, 'drug');
    expect(v.emotion.axes['anger']).toBeCloseTo(DEFAULT_ITEMS.drugAnger, 6);
    expect(v.wealth).toBe(100 - DEFAULT_ITEMS.drugWealthLoss);
    expect(v.eventParams[DRUG_TAG]).toBe(1);
  });

  it('collectItems: 最寄りの住民が拾い、items は空になる', () => {
    const near = vAt('near', 1, 1);
    const far = vAt('far', 20, 20);
    const world = createWorld([near, far]);
    world.items = [{ id: 'item_1', kind: 'precious', position: { x: 2, y: 2 } }];
    const pickups = collectItems(world);
    expect(pickups).toHaveLength(1);
    expect(pickups[0]?.villagerId).toBe('near');
    expect(near.wealth).toBe(100 + DEFAULT_ITEMS.preciousWealth);
    expect(world.items).toHaveLength(0);
  });

  it('TermMachine.placeItem はフィールドに積む / giveChampionItem は直接適用', () => {
    const champ = vAt('c', 5, 5);
    const world = createWorld([champ, vAt('b', 1, 1)]);
    const tm = new TermMachine(world, new StubBrain(), { rng: seqRng([0.0, 0.2, 0.4]) });
    const item = tm.placeItem('precious');
    expect(world.items).toContain(item);
    expect(item.kind).toBe('precious');

    const res = tm.giveChampionItem('precious', 'c');
    expect(res?.name).toBe('c');
    expect(champ.wealth).toBe(100 + DEFAULT_ITEMS.preciousWealth);

    expect(tm.giveChampionItem('drug', 'ghost')).toBeNull(); // 不在
  });

  it('薬物を拾った個体は非行に走りやすい (base_drugged)', () => {
    const env: EnvironmentView = { position: { x: 0, y: 0 }, place: '広場', timeOfDay: 'noon', nearby: [] };
    const clean = vAt('a', 0, 0);
    const drugged = vAt('b', 0, 0);
    applyItemEffect(drugged, 'drug');
    const rules = defaultBehaviorRules();
    const cleanW = evaluateRules(rules, { villager: clean, env, category: 'wander' }).triggerWeight;
    const druggedW = evaluateRules(rules, { villager: drugged, env, category: 'wander' }).triggerWeight;
    expect(druggedW).toBeGreaterThan(cleanW);
  });
});
