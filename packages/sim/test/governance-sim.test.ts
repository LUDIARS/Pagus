import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  StubBrain,
  TermMachine,
  DailyEngine,
  DEFAULT_CONFIG,
  type World,
  type IncidentDesign,
} from '../src/index.js';
import type { EnvironmentView } from '../src/brain.js';

function world(): World {
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.6 } });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 13, y: 12 }, activity: 'always' });
  return createWorld([a, b], DEFAULT_CONFIG, { year: 2026, month: 6 });
}

/** designed/未発火のスケジュール事件を仕込む (当日 = dayOfMonth)。 */
function armScheduledIncident(w: World): void {
  const design: IncidentDesign = {
    description: '広場の騒ぎ',
    newCharacters: [],
    involvedIds: ['b'],
    perpetratorId: 'a',
    scapegoat: false,
    framedTargetId: null,
  };
  w.scheduledIncident = {
    dayOfMonth: w.calendar.dayOfMonth,
    themeSeed: 'seed',
    designed: true,
    fired: false,
    design,
  };
  w.phase = 'kisho';
}

describe('戒厳令 (§v1.3-C ⑨ setMartial / martialActive / prune)', () => {
  it('setMartial で untilTerm=term+days を立て、term<=untilTerm の間 active', () => {
    const w = world();
    w.term = 5;
    const tm = new TermMachine(w, new StubBrain());
    tm.setMartial('freeze', 2);
    expect(w.martial).toEqual({ mode: 'freeze', untilTerm: 7 });
    expect(tm.martialActive('freeze')).toBe(true);
    expect(tm.martialActive('surge')).toBe(false);
    w.term = 7;
    expect(tm.martialActive('freeze')).toBe(true);
    w.term = 8; // untilTerm(7) < term(8) → 失効
    expect(tm.martialActive()).toBe(false);
  });

  it('pruneExpiredMartial は失効分だけ解除して mode を返す', () => {
    const w = world();
    w.term = 5;
    const tm = new TermMachine(w, new StubBrain());
    tm.setMartial('surge', 1); // untilTerm=6
    w.term = 6;
    expect(tm.pruneExpiredMartial()).toBeNull(); // まだ有効
    w.term = 7;
    expect(tm.pruneExpiredMartial()).toBe('surge');
    expect(w.martial).toBeUndefined();
  });

  it('freeze 中は fireScheduledIncident を抑止し、解除後は発火する', () => {
    const w = world();
    armScheduledIncident(w);
    const tm = new TermMachine(w, new StubBrain());
    tm.setMartial('freeze', 2);
    expect(tm.fireScheduledIncident()).toBe(false); // 凍結中は発火しない
    expect(w.incident).toBeNull();
    // 凍結を解いて再挑戦 (同じ designed/未発火の事件)。
    delete w.martial;
    expect(tm.fireScheduledIncident()).toBe(true);
    expect(w.phase).toBe('sho');
  });
});

describe('戒厳令 surge (§v1.3-C ⑨ DailyEngine.setSurge)', () => {
  function envWithNeighbor(): EnvironmentView {
    return { position: { x: 12, y: 12 }, place: '広場', timeOfDay: 'noon', nearby: [{ id: 'b', name: 'ベル', pos: { x: 13, y: 12 } }] };
  }
  it('surge ボーナスで事件化閾値が下がり早く発火する', () => {
    const eng = new DailyEngine({ rng: () => 0.5, triggerAfter: 6 });
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 } });
    eng.setSurge(5); // 閾値 = max(1, 6-5) = 1 → 1 行動目で発火
    expect(eng.decide(v, envWithNeighbor(), null).triggersIncident).toBe(true);
  });
  it('surge=0 (平時) は triggerAfter どおり', () => {
    const eng = new DailyEngine({ rng: () => 0.5, triggerAfter: 3 });
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 } });
    eng.setSurge(0);
    expect(eng.decide(v, envWithNeighbor(), null).triggersIncident).toBe(false); // 1
    expect(eng.decide(v, envWithNeighbor(), null).triggersIncident).toBe(false); // 2
    expect(eng.decide(v, envWithNeighbor(), null).triggersIncident).toBe(true); // 3
  });
});

describe('革命の決着 (§v1.3-C ⑧ applyRevolt)', () => {
  it('incite 勝利は悪辣↑秩序↓、suppress 勝利は悪辣↓秩序↑ (0..1 クランプ)', () => {
    const w = world();
    w.reputation.malice = 0.5;
    w.reputation.order = 0.5;
    const tm = new TermMachine(w, new StubBrain());
    tm.applyRevolt('incite');
    expect(w.reputation.malice).toBeCloseTo(0.7, 6);
    expect(w.reputation.order).toBeCloseTo(0.35, 6);
    tm.applyRevolt('suppress');
    expect(w.reputation.malice).toBeCloseTo(0.5, 6);
    expect(w.reputation.order).toBeCloseTo(0.5, 6);
  });
});

describe('村基金イベント (§v1.3-C ⑩ villageFundEvent)', () => {
  it('festival は活気を上げ、relief は全住民の stress を下げる', () => {
    const w = world();
    w.reputation.vitality = 0.4;
    w.villagers.get('a')!.stress = 3;
    w.villagers.get('b')!.stress = 1;
    const tm = new TermMachine(w, new StubBrain());
    expect(tm.villageFundEvent('festival')).toBe(0);
    expect(w.reputation.vitality).toBeCloseTo(0.55, 6);
    const n = tm.villageFundEvent('relief');
    expect(n).toBe(2);
    expect(w.villagers.get('a')!.stress).toBe(1); // 3-2
    expect(w.villagers.get('b')!.stress).toBe(0); // max(0, 1-2)
  });
});
