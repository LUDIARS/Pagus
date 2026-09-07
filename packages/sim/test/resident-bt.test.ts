// 住民の自律BT版 (PAGUS_RESIDENT_CONTROL=bt = 既定) の回帰テスト。
// 既存の 299 件は legacy 経路しか通らないため、既定経路をここで押さえる。
import { describe, it, expect } from 'vitest';
import {
  createVillager,
  createWorld,
  finalizeResidentAction,
  educationHolds,
  educationDirection,
  educationPartsFor,
  recordEducation,
  EDUCATION_GATE_TERMS,
  ResidentBtBrain,
} from '../src/index.js';
import { manipulationTree } from '../src/resident-trial-tree.js';
import type { ActionDecision } from '../src/brain.js';
import type { Personality } from '../src/personality.js';
import type { Villager, World } from '../src/types/index.js';

function worldWith(...villagers: Villager[]): World {
  return createWorld(villagers);
}

function resident(id: string, traits: Partial<Personality> = {}): Villager {
  return createVillager({ id, name: id, position: { x: 12, y: 12 }, traits });
}

/** 共感教育を 1 回受けた住民を作る (term 0 で教育)。 */
function educated(v: Villager, term = 0): Villager {
  v.persona.traits.kindness = 0.8;
  v.persona.traits.aggression = 0.2;
  recordEducation(
    v,
    { kind: 'educate', villager: v.id, direction: 'empathy', rationale: '他者の痛みに気付く' },
    term,
    { ...v.appearance, descriptors: [...v.appearance.descriptors] },
    { ...v.persona.traits, kindness: 0.2, aggression: 0.8 },
  );
  return v;
}

const harmful: ActionDecision = {
  move: null,
  action: '殴りかかる',
  newEmotion: { axes: {}, label: '怒り' },
  triggersIncident: true,
  incidentSeed: { description: '暴力', involved: ['b'] },
};

describe('教育による抑制は有限である (事件→裁判→教育ループの枯渇防止)', () => {
  it('教育直後は加害行動を抑制する', () => {
    const v = educated(resident('a'));
    const world = worldWith(v, resident('b'));
    world.term = 0;
    expect(educationPartsFor(v)).toContain('tentacles');
    const out = finalizeResidentAction(world, v, { ...harmful });
    expect(out.triggersIncident).toBe(false);
    expect(v.behaviorTrace?.gate).toBe('共感の教育が加害行動を抑制');
  });

  it('十分な日数が経てば抑制が解け、再び事件を起こしうる', () => {
    const v = educated(resident('a'));
    const world = worldWith(v, resident('b'));
    world.term = EDUCATION_GATE_TERMS;
    // 性格は教育後のまま (kindness > aggression) だが、抑制は期限切れになる。
    expect(v.persona.traits.kindness).toBeGreaterThan(v.persona.traits.aggression);
    expect(educationHolds(v, world.term)).toBe(false);
    finalizeResidentAction(world, v, { ...harmful });
    expect(v.behaviorTrace?.gate ?? null).toBe(null);
  });

  it('性格だけでは抑制を判定しない (educationTree が empathy を選ぶ条件と一致してしまうため)', () => {
    const v = educated(resident('a'));
    // 教育は aggression > kindness のときに empathy を選び、+0.4 の相対変化を与える。
    // 性格比較で抑制すると以後永久に真になり、住民が事件経済から消える。
    expect(v.persona.traits.kindness > v.persona.traits.aggression).toBe(true);
    expect(educationHolds(v, EDUCATION_GATE_TERMS + 1)).toBe(false);
  });

  it('教育を受けていない住民は抑制されない', () => {
    const v = resident('a', { aggression: 0.9, kindness: 0.1 });
    expect(educationHolds(v, 0)).toBe(false);
    const world = worldWith(v, resident('b'));
    finalizeResidentAction(world, v, { ...harmful });
    expect(v.behaviorTrace?.gate ?? null).toBe(null);
  });

  it('ストレスが高いほど早く抑制が切れる', () => {
    const calm = educated(resident('a'));
    const stressed = educated(resident('c'));
    stressed.stress = 20;
    const term = EDUCATION_GATE_TERMS - 2;
    expect(educationHolds(calm, term)).toBe(true);
    expect(educationHolds(stressed, term)).toBe(false);
  });

  it('裁判での圧力も期限切れ後は再び掛かる', () => {
    const madman = educated(resident('m', { ambition: 0.9, kindness: 0.1 }));
    madman.madman = true;
    expect(manipulationTree(madman, 0)).toBe(false);
    expect(manipulationTree(madman, EDUCATION_GATE_TERMS + 1)).toBe(true);
  });
});

describe('教育の方向判定', () => {
  it('traits の差分が無い改変を「共感」と偽らない', () => {
    const flat: Personality = {
      aggression: 0.5, kindness: 0.5, discipline: 0.5,
      curiosity: 0.5, sociability: 0.5, ambition: 0.5,
    };
    expect(educationDirection(flat, { ...flat })).toBe('curiosity');
  });

  it('実際に上がった軸を方向として選ぶ', () => {
    const before: Personality = {
      aggression: 0.5, kindness: 0.5, discipline: 0.5,
      curiosity: 0.5, sociability: 0.5, ambition: 0.5,
    };
    expect(educationDirection(before, { ...before, discipline: 0.9 })).toBe('discipline');
    expect(educationDirection(before, { ...before, kindness: 0.9 })).toBe('empathy');
  });
});

describe('ResidentBtBrain (既定の住民脳)', () => {
  const incident = {
    id: 'i1', perpetrator: 'a', involved: ['b'], description: '口論',
    damage: 1, steps: [], resolved: false,
  };

  it('教育直後は事件を打ち切る', async () => {
    const perp = educated(resident('a', { aggression: 0.9, discipline: 0.1 }));
    const step = await new ResidentBtBrain().advanceIncident({
      incident, perspective: 'perpetrator', perpetrator: perp, victims: [resident('b')], term: 0,
    });
    expect(step.ended).toBe(true);
    expect(step.damageDelta).toBe(0);
  });

  it('抑制期限が切れれば、同じ住民でも事件が続く', async () => {
    const perp = educated(resident('a'));
    perp.persona.traits.aggression = 0.9;
    perp.persona.traits.discipline = 0.1;
    const step = await new ResidentBtBrain().advanceIncident({
      incident, perspective: 'perpetrator', perpetrator: perp,
      victims: [resident('b')], term: EDUCATION_GATE_TERMS + 1,
    });
    expect(step.ended).toBe(false);
    expect(step.damageDelta).toBeGreaterThan(0);
  });
});
