import { describe, it, expect } from 'vitest';
import { createWorld, createVillager, StubBrain, TermMachine, DEFAULT_CONFIG, FAMILY_TIME } from '../src/index.js';

function pairWorld() {
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 1, y: 1 }, activity: 'always' });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 2, y: 1 }, activity: 'always' });
  return createWorld([a, b], DEFAULT_CONFIG, { year: 2026, month: 6 });
}

describe('生活イベント (結婚/出産)', () => {
  it('marriageChance=1 で 2 体が結婚し partnerId が相互に張られる', () => {
    const w = pairWorld();
    const tm = new TermMachine(w, new StubBrain(), { marriageChance: 1, birthChance: 0, rng: () => 0.1 });
    const ev = tm.lifeEvents();
    expect(ev.marriages).toHaveLength(1);
    expect(w.villagers.get('a')?.partnerId).toBe('b');
    expect(w.villagers.get('b')?.partnerId).toBe('a');
    expect(w.relationships.some((r) => r.from === 'a' && r.to === 'b' && r.kind === 'spouse')).toBe(true);
  });

  it('夫婦から出産すると村人が増える (気質はブレンド)', () => {
    const w = pairWorld();
    const tm = new TermMachine(w, new StubBrain(), { marriageChance: 1, birthChance: 1, rng: () => 0.1 });
    const ev = tm.lifeEvents();
    expect(ev.births).toHaveLength(1);
    expect(w.villagers.size).toBe(3);
    const child = w.villagers.get(ev.births[0]!.childId);
    expect(child?.alive).toBe(true);
  });

  it('既定 (確率0) では生活イベントは起きない', () => {
    const w = pairWorld();
    const tm = new TermMachine(w, new StubBrain());
    const ev = tm.lifeEvents();
    expect(ev.marriages).toHaveLength(0);
    expect(ev.births).toHaveLength(0);
  });

  it('十分な住民がいる世界には夫婦と恋愛関係を補完する', () => {
    const villagers = ['a', 'b', 'c', 'd'].map((id, i) => createVillager({
      id,
      name: `住民${i}`,
      position: { x: i, y: 1 },
      activity: 'always',
    }));
    const w = createWorld(villagers, DEFAULT_CONFIG, { year: 2026, month: 6 });
    new TermMachine(w, new StubBrain(), { rng: () => 0.4 });
    const spouses = w.relationships.filter((r) => r.kind === 'spouse');
    const romances = w.relationships.filter((r) => r.kind === 'romance');
    expect(spouses.length).toBeGreaterThanOrEqual(2);
    expect(romances.length).toBeGreaterThanOrEqual(2);
    const spouse = spouses[0]!;
    expect(w.villagers.get(spouse.from)?.partnerId).toBe(spouse.to);
  });

  it('相手宅で家族の時間を過ごすと出生判定が押し上がる', async () => {
    const w = pairWorld();
    w.villagers.get('a')!.partnerId = 'b';
    w.villagers.get('b')!.partnerId = 'a';
    w.calendar.segment = 11;
    w.phase = 'kisho';
    const tm = new TermMachine(w, new StubBrain(), { birthChance: 0, dailyTriggerAfter: 99, rng: () => 0 });
    const tick = await tm.kishoTick();
    expect(tick.actions.some((a) => a.action.includes('家に行き'))).toBe(true);
    expect((w.villagers.get('a')!.eventParams[FAMILY_TIME] ?? 0) + (w.villagers.get('b')!.eventParams[FAMILY_TIME] ?? 0)).toBeGreaterThan(0);
    w.phase = 'advance';
    const ev = tm.lifeEvents();
    expect(ev.births).toHaveLength(1);
  });
});
