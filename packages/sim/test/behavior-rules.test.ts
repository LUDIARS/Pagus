import { describe, it, expect } from 'vitest';
import {
  evaluateRules,
  BASE_BEHAVIOR_RULES,
  DailyEngine,
  TermMachine,
  StubBrain,
  StubWorldBrain,
  createWorld,
  createVillager,
  DEFAULT_CONFIG,
  type BehaviorRule,
  type RuleEvalContext,
} from '../src/index.js';
import type { EnvironmentView } from '../src/brain.js';

function env(neighbor = false): EnvironmentView {
  return {
    position: { x: 12, y: 12 },
    place: '広場',
    timeOfDay: 'noon',
    nearby: neighbor ? [{ id: 'b', name: 'ベル', pos: { x: 13, y: 12 } }] : [],
  };
}

describe('evaluateRules (ふるまいの法則の決定的評価, §2.1)', () => {
  it('条件は AND: 全条件 match で初めて効果が出る', () => {
    const rule: BehaviorRule = {
      id: 'r1',
      source: 'haiku',
      description: '攻撃的かつ広場で怒る',
      when: [
        { kind: 'traitAbove', axis: 'aggression', value: 0.5 },
        { kind: 'place', place: '広場' },
      ],
      then: [{ kind: 'emotionDelta', emotionAxis: 'anger', delta: 0.3 }],
    };
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, traits: { aggression: 0.7 } });
    const ctx: RuleEvalContext = { villager: v, env: env(), category: 'wander' };
    expect(evaluateRules([rule], ctx).emotionDeltas['anger']).toBeCloseTo(0.3);

    // 片方の条件 (place) を外すと効果が出ない。
    const ctx2: RuleEvalContext = { villager: v, env: { ...env(), place: '村はずれ' }, category: 'wander' };
    expect(evaluateRules([rule], ctx2).emotionDeltas['anger']).toBeUndefined();
  });

  it('効果は集約: emotionDelta は加算 / triggerWeight は加算 / flavor は最後を採用', () => {
    const rules: BehaviorRule[] = [
      { id: 'r1', source: 'haiku', description: 'a', when: [{ kind: 'hasNeighbor' }], then: [{ kind: 'emotionDelta', emotionAxis: 'joy', delta: 0.2 }, { kind: 'triggerWeight', delta: 1 }, { kind: 'actionFlavor', text: '最初の彩り' }] },
      { id: 'r2', source: 'haiku', description: 'b', when: [{ kind: 'hasNeighbor' }], then: [{ kind: 'emotionDelta', emotionAxis: 'joy', delta: 0.1 }, { kind: 'triggerWeight', delta: 2 }, { kind: 'actionFlavor', text: '最後の彩り' }] },
    ];
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 } });
    const r = evaluateRules(rules, { villager: v, env: env(true), category: 'wander' });
    expect(r.emotionDeltas['joy']).toBeCloseTo(0.3);
    expect(r.triggerWeight).toBe(3);
    expect(r.flavor).toBe('最後の彩り');
  });
});

describe('BASE ルールで旧 nudgeEmotion を再現する (退行ゼロ)', () => {
  it('harass で怒り↑・喜び↓ / good で喜び↑・怒り↓', () => {
    const eng = new DailyEngine({ rng: () => 0.5, behaviorRules: BASE_BEHAVIOR_RULES });
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 } });

    const harass = eng.decide(v, env(true), { category: 'harass', actor: 'a', target: 'b' });
    expect(harass.newEmotion.axes['anger']).toBeCloseTo(0.2);
    expect(harass.newEmotion.axes['joy']).toBeCloseTo(-0.1);

    const good = eng.decide(v, env(false), { category: 'good', actor: 'a', target: null });
    expect(good.newEmotion.axes['joy']).toBeGreaterThan(0);
    expect(good.newEmotion.axes['anger']).toBeLessThan(0);
  });
});

describe('maybeGrowRule (RuleSmith, §2.1)', () => {
  function world() {
    const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, traits: { aggression: 0.8 } });
    return createWorld([a], DEFAULT_CONFIG, { year: 2026, month: 6 });
  }

  it('worldBrain が無ければ null', async () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain()); // worldBrain 未指定
    expect(await tm.maybeGrowRule()).toBeNull();
  });

  it('world.behaviorRules を増やし、上限で古い haiku を間引く (base は保持)', async () => {
    const w = world();
    const baseCount = w.behaviorRules.length; // 4 (base)
    const tm = new TermMachine(w, new StubBrain(), { worldBrain: new StubWorldBrain(), rulesMax: baseCount + 2 });

    const r1 = await tm.maybeGrowRule();
    expect(r1).not.toBeNull();
    expect(r1?.source).toBe('haiku');
    expect(w.behaviorRules.length).toBe(baseCount + 1);

    await tm.maybeGrowRule(); // base+2 (上限ちょうど)
    expect(w.behaviorRules.length).toBe(baseCount + 2);

    await tm.maybeGrowRule(); // 上限超過 → 古い haiku を 1 件間引く
    expect(w.behaviorRules.length).toBe(baseCount + 2);

    // base ルールは間引かれず残り、haiku が 2 件。
    expect(w.behaviorRules.filter((r) => r.source === 'base').length).toBe(baseCount);
    expect(w.behaviorRules.filter((r) => r.source === 'haiku').length).toBe(2);
  });
});
