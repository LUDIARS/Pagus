import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  StubBrain,
  TermMachine,
  DEFAULT_CONFIG,
  aliveVillagers,
  type World,
} from '../src/index.js';

function world(): World {
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, activity: 'always' });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 13, y: 12 }, activity: 'always' });
  return createWorld([a, b], DEFAULT_CONFIG, { year: 2026, month: 6 });
}

describe('観客の祈りバフ (§v1.3-D ㉕ applyPrayerBuff)', () => {
  it('善良/活気 +0.05、全生存どうぶつの stress を 1 下げる', () => {
    const w = world();
    w.reputation.benevolence = 0.4;
    w.reputation.vitality = 0.4;
    w.villagers.get('a')!.stress = 3;
    w.villagers.get('b')!.stress = 0;
    const tm = new TermMachine(w, new StubBrain());
    expect(tm.applyPrayerBuff()).toBe(2);
    expect(w.reputation.benevolence).toBeCloseTo(0.45, 6);
    expect(w.reputation.vitality).toBeCloseTo(0.45, 6);
    expect(w.villagers.get('a')!.stress).toBe(2);
    expect(w.villagers.get('b')!.stress).toBe(0); // 下限0
  });
});

describe('共闘レイド villain (§v1.3-D ㉙ spawnVillain / despawnVillain)', () => {
  it('強気質の incident キャラを spawn し、despawn で退場 (alive=false)', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain());
    const before = aliveVillagers(w).length;
    const v = tm.spawnVillain('黒爪のガロ');
    expect(v.origin).toBe('incident');
    expect(v.persona.traits.aggression).toBeGreaterThan(0.9);
    expect(aliveVillagers(w).length).toBe(before + 1);
    expect(tm.despawnVillain(v.id)).toBe(true);
    expect(w.villagers.get(v.id)!.alive).toBe(false);
    expect(tm.despawnVillain(v.id)).toBe(false); // 既に退場
  });

  it('incident id の通し番号は getIncidentCount に反映される', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain(), { incidentCount: 5 });
    const v = tm.spawnVillain('影喰いゾル');
    expect(v.id).toBe('incident_6');
    expect(tm.getIncidentCount()).toBe(6);
  });
});

describe('レイド失敗の被害 (§v1.3-D ㉙ applyRaidFailure)', () => {
  it('悪辣 +0.15 / 活気 -0.1 (クランプ)、全生存どうぶつ stress +2', () => {
    const w = world();
    w.reputation.malice = 0.5;
    w.reputation.vitality = 0.05;
    w.villagers.get('a')!.stress = 1;
    const tm = new TermMachine(w, new StubBrain());
    expect(tm.applyRaidFailure()).toBe(2);
    expect(w.reputation.malice).toBeCloseTo(0.65, 6);
    expect(w.reputation.vitality).toBeCloseTo(0, 6); // max(0, 0.05-0.1)
    expect(w.villagers.get('a')!.stress).toBe(3);
  });
});
