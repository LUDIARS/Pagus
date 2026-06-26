import { describe, it, expect } from 'vitest';
import { createWorld, createVillager, StubBrain, TermMachine, DEFAULT_CONFIG } from '../src/index.js';

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
});
