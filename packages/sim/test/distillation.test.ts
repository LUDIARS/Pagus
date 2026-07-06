import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  StubBrain,
  StubWorldBrain,
  TermMachine,
  DEFAULT_CONFIG,
  evaluateRules,
  defaultBehaviorRules,
  agreementRate,
  shouldAdoptRule,
  RULE_DSL_VERSION,
  type World,
  type BehaviorRule,
  type DivergenceCase,
  type Villager,
} from '../src/index.js';
import type { EnvironmentView } from '../src/brain.js';

function smallWorld(): World {
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.6 } });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 15, y: 12 }, activity: 'always' });
  return createWorld([a, b], { ...DEFAULT_CONFIG, damageThreshold: 8 }, { year: 2026, month: 6 });
}

function envOf(v: Villager): EnvironmentView {
  return { position: { ...v.position }, place: '広場', timeOfDay: 'noon', nearby: [] };
}

function rule(partial: Partial<BehaviorRule> & Pick<BehaviorRule, 'id' | 'when' | 'then'>): BehaviorRule {
  return { source: 'haiku', description: partial.id, ...partial };
}

function caseOf(overrides: Partial<DivergenceCase> = {}): DivergenceCase {
  return {
    term: 1,
    villager: {
      id: 'a',
      species: '猫',
      traits: { aggression: 0.6 },
      emotionAxes: { anger: 0.2 },
      eventParams: {},
      wealth: 100,
      stress: 0,
      infoTexts: [],
      infoFromPlayer: false,
    },
    env: { place: '広場', timeOfDay: 'noon', hasNeighbor: true },
    category: 'wander',
    teacher: { emotionDelta: { anger: 0.2 }, triggersIncident: false },
    student: { triggersIncident: false },
    ...overrides,
  };
}

describe('DSL v2 (§v1.4-C 条件/効果)', () => {
  it('RULE_DSL_VERSION は 2', () => {
    expect(RULE_DSL_VERSION).toBe(2);
  });

  it('infoContains / infoFromPlayer / stressAbove / emotionBelow が match する', () => {
    const w = smallWorld();
    const a = w.villagers.get('a');
    if (!a) throw new Error('a がいない');
    a.information.push({ id: 'i1', text: '井戸の噂を聞いた', source: 'player', termAcquired: 0 });
    a.stress = 3;
    a.emotion.axes['joy'] = -0.5;
    const env = envOf(a);
    const rules: BehaviorRule[] = [
      rule({ id: 'r1', when: [{ kind: 'infoContains', substr: '井戸' }], then: [{ kind: 'triggerWeight', delta: 1 }] }),
      rule({ id: 'r2', when: [{ kind: 'infoFromPlayer' }], then: [{ kind: 'triggerWeight', delta: 1 }] }),
      rule({ id: 'r3', when: [{ kind: 'stressAbove', value: 2 }], then: [{ kind: 'triggerWeight', delta: 1 }] }),
      rule({ id: 'r4', when: [{ kind: 'emotionBelow', emotionAxis: 'joy', value: 0 }], then: [{ kind: 'triggerWeight', delta: 1 }] }),
      rule({ id: 'r5', when: [{ kind: 'infoContains', substr: '存在しない' }], then: [{ kind: 'triggerWeight', delta: 100 }] }),
    ];
    const r = evaluateRules(rules, { villager: a, env, category: 'wander' });
    expect(r.triggerWeight).toBe(4); // r1..r4 が match、r5 は不一致
  });

  it('spreadInfo / moveBias / wealthDelta が集約される', () => {
    const w = smallWorld();
    const a = w.villagers.get('a');
    if (!a) throw new Error('a がいない');
    const rules: BehaviorRule[] = [
      rule({ id: 'r1', when: [{ kind: 'hasNeighbor' }], then: [{ kind: 'spreadInfo' }, { kind: 'wealthDelta', delta: -5 }] }),
      rule({ id: 'r2', when: [{ kind: 'hasNeighbor' }], then: [{ kind: 'moveBias', towards: 'partner' }, { kind: 'wealthDelta', delta: 2 }] }),
    ];
    const env: EnvironmentView = { ...envOf(a), nearby: [{ id: 'b', name: 'ベル', pos: { x: 15, y: 12 } }] };
    const r = evaluateRules(rules, { villager: a, env, category: 'wander' });
    expect(r.spreadInfo).toBe(true);
    expect(r.moveBias).toBe('partner');
    expect(r.wealthDelta).toBe(-3);
  });

  it('TermMachine: 副作用 (wealthDelta / spreadInfo / moveBias) が村へ適用される', async () => {
    const w = smallWorld();
    const a = w.villagers.get('a');
    const b = w.villagers.get('b');
    if (!a || !b) throw new Error('missing');
    a.partnerId = 'b';
    a.information.push({ id: 'i1', text: '秘密を知っている', source: 'observation', termAcquired: 0 });
    w.behaviorRules.push(
      rule({ id: 'fx', when: [{ kind: 'actionCategory', category: 'wander' }], then: [{ kind: 'wealthDelta', delta: -7 }, { kind: 'spreadInfo' }, { kind: 'moveBias', towards: 'partner' }] }),
    );
    const wealthBefore = a.wealth;
    const xBefore = a.position.x;
    const tm = new TermMachine(w, new StubBrain(), { dailyTriggerAfter: 99, rng: () => 0.5 }); // rng 0.5 → うろつき移動は 0
    tm.startDay();
    await tm.kishoTick();
    expect(a.wealth).toBe(wealthBefore - 7);
    expect(b.information.some((i) => i.text.includes('秘密'))).toBe(true); // 噂の自然伝播
    expect(a.position.x).toBeGreaterThan(xBefore); // partner (x=15) へ寄った
  });
});

describe('replay ゲート (§v1.4-C rule-replay)', () => {
  it('教師の傾向を写すルールは一致率を上げ、採用される', () => {
    const cases = [caseOf(), caseOf(), caseOf()];
    const base = defaultBehaviorRules().filter((r) => r.id === 'base_chat'); // wander に無関係な最小集合
    const good = rule({
      id: 'good',
      when: [{ kind: 'actionCategory', category: 'wander' }],
      then: [{ kind: 'emotionDelta', emotionAxis: 'anger', delta: 0.1 }],
    });
    const gate = shouldAdoptRule(base, good, cases, 0.1);
    expect(gate.after).toBeGreaterThan(gate.before);
    expect(gate.adopt).toBe(true);
  });

  it('教師と逆向きのルールは採用されない', () => {
    const cases = [caseOf(), caseOf()];
    const base = defaultBehaviorRules().filter((r) => r.id === 'base_chat');
    const bad = rule({
      id: 'bad',
      when: [{ kind: 'actionCategory', category: 'wander' }],
      then: [{ kind: 'emotionDelta', emotionAxis: 'anger', delta: -0.1 }], // 教師は anger+
    });
    const gate = shouldAdoptRule(base, bad, cases, 0.1);
    expect(gate.adopt).toBe(false);
  });

  it('agreementRate は事件傾向 (triggerWeight) も見る', () => {
    const c = caseOf({ teacher: { emotionDelta: {}, triggersIncident: true } });
    const withTrigger = [rule({ id: 't', when: [{ kind: 'actionCategory', category: 'wander' }], then: [{ kind: 'triggerWeight', delta: 2 }] })];
    expect(agreementRate(withTrigger, [c])).toBeGreaterThan(agreementRate([], [c]));
  });
});

describe('蒸留の起案と追加 (§v1.4-C)', () => {
  it('StubWorldBrain.distillRule は先頭ケースの教師傾向を写す決定的ルールを返す', async () => {
    const brain = new StubWorldBrain();
    const w = smallWorld();
    const r = await brain.distillRule({ reputation: w.reputation, calendar: w.calendar, existingRules: [], cases: [caseOf()] });
    expect(r.source).toBe('distill');
    expect(r.when[0]).toEqual({ kind: 'actionCategory', category: 'wander' });
    expect(r.then[0]).toEqual({ kind: 'emotionDelta', emotionAxis: 'anger', delta: 0.05 });
  });

  it('addDistilledRule は rule_distill_N を振り、上限間引きは haiku を先に捨てる', () => {
    const w = smallWorld();
    const baseCount = w.behaviorRules.length;
    const tm = new TermMachine(w, new StubBrain(), { rulesMax: baseCount + 2 });
    w.behaviorRules.push(rule({ id: 'h1', source: 'haiku', when: [{ kind: 'hasNeighbor' }], then: [{ kind: 'triggerWeight', delta: 1 }], description: 'h1' }));
    const d1 = tm.addDistilledRule(rule({ id: 'x', source: 'distill', when: [{ kind: 'hasNeighbor' }], then: [{ kind: 'triggerWeight', delta: 1 }], description: 'd1' }));
    expect(d1.id).toMatch(/^rule_distill_/);
    // 上限到達 → 次の追加で haiku (h1) が先に消え、distill は残る。
    tm.addDistilledRule(rule({ id: 'y', source: 'distill', when: [{ kind: 'hasNeighbor' }], then: [{ kind: 'triggerWeight', delta: 1 }], description: 'd2' }));
    expect(w.behaviorRules.some((r) => r.id === 'h1')).toBe(false);
    expect(w.behaviorRules.some((r) => r.id === d1.id)).toBe(true);
  });

  it('onDailyDecision フックが日常決定ごとに呼ばれる', async () => {
    const w = smallWorld();
    const seen: string[] = [];
    const tm = new TermMachine(w, new StubBrain(), {
      dailyTriggerAfter: 99,
      onDailyDecision: (v, _env, d) => {
        seen.push(v.id);
        expect(typeof d.action).toBe('string');
      },
    });
    tm.startDay();
    await tm.kishoTick();
    expect(seen.length).toBeGreaterThan(0);
  });
});
