import { describe, it, expect } from 'vitest';
import { DailyEngine, REACTION_EXPOSURE, createVillager, lifeProfileFor } from '../src/index.js';
import type { EnvironmentView } from '../src/brain.js';

function envWith(neighbor: boolean, timeOfDay: EnvironmentView['timeOfDay'] = 'noon'): EnvironmentView {
  return {
    position: { x: 12, y: 12 },
    place: '広場',
    timeOfDay,
    nearby: neighbor ? [{ id: 'b', name: 'ベル', pos: { x: 13, y: 12 } }] : [],
  };
}

describe('DailyEngine (日常 = LLM 非依存)', () => {
  it('自由行動は triggerAfter 回目に周囲がいれば事件化する', () => {
    const eng = new DailyEngine({ rng: () => 0.5, triggerAfter: 3 });
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 } });
    v.wealth = 200; // §15 経済ルールの影響を除いて triggerAfter 単体を検証する (貧困だと閾値が下がる)
    const env = envWith(true);
    expect(eng.decide(v, env, null).triggersIncident).toBe(false); // 1
    expect(eng.decide(v, env, null).triggersIncident).toBe(false); // 2
    const third = eng.decide(v, env, null); // 3 → 発火
    expect(third.triggersIncident).toBe(true);
    expect(third.incidentSeed?.involved).toEqual(['b']);
  });

  it('周囲に誰もいなければ事件化しない', () => {
    const eng = new DailyEngine({ rng: () => 0.5, triggerAfter: 1 });
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 } });
    expect(eng.decide(v, envWith(false), null).triggersIncident).toBe(false);
  });

  it('forceNext (扇動) は次の自由行動で即事件化する', () => {
    const eng = new DailyEngine({ rng: () => 0.5, triggerAfter: 99 });
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 } });
    eng.forceNext();
    expect(eng.decide(v, envWith(true), null).triggersIncident).toBe(true);
  });

  it('イベント由来パラメータが高いほど閾値が下がる (§12.6)', () => {
    const eng = new DailyEngine({ rng: () => 0.5, triggerAfter: 5 });
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 } });
    v.eventParams[REACTION_EXPOSURE] = 4; // 閾値 5-4=1 → 1 行動目で発火
    expect(eng.decide(v, envWith(true), null).triggersIncident).toBe(true);
  });

  it('harass directive は事件化し、good/chat は事件化しない', () => {
    const eng = new DailyEngine({ rng: () => 0.5 });
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 } });
    const harass = eng.decide(v, envWith(true), { category: 'harass', actor: 'a', target: 'b' });
    expect(harass.triggersIncident).toBe(true);
    expect(harass.incidentSeed?.involved).toEqual(['b']);
    expect(eng.decide(v, envWith(true), { category: 'good', actor: 'a', target: null }).triggersIncident).toBe(false);
    expect(eng.decide(v, envWith(true), { category: 'chat', actor: 'a', target: null }).triggersIncident).toBe(false);
  });

  it('感情をアルゴリズムで変異させる (LLM 非依存)', () => {
    const eng = new DailyEngine({ rng: () => 0.5 });
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 } });
    const good = eng.decide(v, envWith(false), { category: 'good', actor: 'a', target: null });
    expect(good.newEmotion.axes['joy']).toBeGreaterThan(0);
  });

  it('職能/日課から生活感ある行動と事件種を作る', () => {
    const eng = new DailyEngine({ rng: () => 0.5, triggerAfter: 6 });
    const v = createVillager({
      id: 'music',
      name: 'リラ',
      position: { x: 12, y: 12 },
      values: ['音楽で気持ちを伝える'],
    });
    v.wealth = 200;

    expect(lifeProfileFor(v).specialty).toBe('musician');
    const decision = eng.decide(v, envWith(true, 'night'), null);
    expect(decision.action).toContain('音楽家');
    expect(decision.triggersIncident).toBe(true);
    expect(decision.incidentSeed?.description).toContain('騒音問題');
  });
});
