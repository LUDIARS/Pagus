import { describe, it, expect } from 'vitest';
import type { Brain, ActionDecision, Villager, DivergenceCase } from '@pagus/sim';
import { createVillager, StubBrain } from '@pagus/sim';
import { DivergenceLog } from '../src/distill/divergence-log.js';
import { ShadowSampler } from '../src/distill/shadow-sampler.js';
import { coerceBehaviorRule } from '../src/llm/json-coerce.js';

function villager(): Villager {
  return createVillager({ id: 'a', name: 'アオ', position: { x: 1, y: 1 }, activity: 'always' });
}

function decision(triggers: boolean, anger = 0): ActionDecision {
  return {
    move: null,
    action: 'テスト行動',
    newEmotion: { axes: { anger }, label: 'ふつう' },
    triggersIncident: triggers,
    incidentSeed: null,
  };
}

/** 常に事件化すると答える教師 (生徒 false と食い違わせる)。 */
function alwaysTriggerTeacher(): Brain {
  const stub = new StubBrain();
  return {
    ...stub,
    updateEmotion: stub.updateEmotion.bind(stub),
    advanceIncident: stub.advanceIncident.bind(stub),
    groupVoteFoolish: stub.groupVoteFoolish.bind(stub),
    groupVoteFate: stub.groupVoteFate.bind(stub),
    decideEducation: stub.decideEducation.bind(stub),
    decideAction: async () => decision(true, 0.5),
  };
}

describe('乖離ログ (§v1.4-C DivergenceLog)', () => {
  const c = (): DivergenceCase => ({
    term: 1,
    villager: { id: 'a', species: '猫', traits: {}, emotionAxes: {}, eventParams: {}, wealth: 0, stress: 0, infoTexts: [], infoFromPlayer: false },
    env: { place: '広場', timeOfDay: 'noon', hasNeighbor: false },
    category: 'wander',
    teacher: { emotionDelta: {}, triggersIncident: true },
    student: { triggersIncident: false },
  });

  it('乖離したケースだけ蒸留待ちに積み、takeCases は消費する', () => {
    const log = new DivergenceLog();
    log.record(c(), true);
    log.record(c(), false); // 一致 → 積まない
    log.record(c(), true);
    expect(log.pendingCount).toBe(2);
    expect(log.stats).toEqual({ sampled: 3, diverged: 2 });
    const taken = log.takeCases(10);
    expect(taken).toHaveLength(2);
    expect(log.pendingCount).toBe(0);
  });

  it('pendingMax を超えたら古いものから捨てる', () => {
    const log = new DivergenceLog({ pendingMax: 2 });
    log.record(c(), true);
    log.record(c(), true);
    log.record(c(), true);
    expect(log.pendingCount).toBe(2);
  });
});

describe('shadow sampling (§v1.4-C ShadowSampler)', () => {
  it('教師と生徒の事件化判断の食い違いを乖離として記録する', async () => {
    const log = new DivergenceLog();
    const sampler = new ShadowSampler(alwaysTriggerTeacher(), log);
    sampler.sample(villager(), { position: { x: 1, y: 1 }, place: '広場', timeOfDay: 'noon', nearby: [] }, decision(false), 3);
    await sampler.flush();
    expect(log.stats.sampled).toBe(1);
    expect(log.pendingCount).toBe(1);
    const [rec] = log.takeCases(1);
    expect(rec?.teacher.triggersIncident).toBe(true);
    expect(rec?.student.triggersIncident).toBe(false);
    expect(rec?.term).toBe(3);
  });

  it('in-flight 上限を超えたサンプルは黙って捨てる (観測のサンプリング)', async () => {
    const log = new DivergenceLog();
    let resolveTeacher: (() => void) | null = null;
    const slowTeacher: Brain = {
      ...alwaysTriggerTeacher(),
      decideAction: () =>
        new Promise((res) => {
          resolveTeacher = () => res(decision(true));
        }),
    };
    const sampler = new ShadowSampler(slowTeacher, log, { maxInFlight: 1 });
    const env = { position: { x: 1, y: 1 }, place: '広場', timeOfDay: 'noon' as const, nearby: [] };
    sampler.sample(villager(), env, decision(false), 1);
    sampler.sample(villager(), env, decision(false), 1); // 上限超 → 捨てる
    resolveTeacher?.();
    await sampler.flush();
    expect(log.stats.sampled).toBe(1);
  });
});

describe('DSL v2 の coerce (§v1.4-C)', () => {
  it('新しい条件/効果 kind を受理する', () => {
    const rule = coerceBehaviorRule({
      description: '噂を持つ者は不安で伝えたがる',
      when: [
        { kind: 'infoFromPlayer' },
        { kind: 'stressAbove', value: 2 },
        { kind: 'emotionBelow', emotionAxis: 'joy', value: 0 },
        { kind: 'infoContains', substr: '噂' },
        { kind: 'wealthBelow', value: 50 },
        { kind: 'placeState', state: 'defiled' },
      ],
      then: [
        { kind: 'spreadInfo' },
        { kind: 'moveBias', towards: 'partner' },
        { kind: 'wealthDelta', delta: -100 },
      ],
    });
    expect(rule.when).toHaveLength(6);
    // wealthDelta は安全域にクランプされる。
    expect(rule.then[2]).toEqual({ kind: 'wealthDelta', delta: -20 });
  });

  it('未知の kind は reject する (無言フォールバック禁止)', () => {
    expect(() =>
      coerceBehaviorRule({ description: 'x', when: [{ kind: 'mindControl' }], then: [{ kind: 'emotionDelta', emotionAxis: 'anger', delta: 0.1 }] }),
    ).toThrow(/未知のルール条件/);
    expect(() =>
      coerceBehaviorRule({ description: 'x', when: [{ kind: 'hasNeighbor' }], then: [{ kind: 'deleteVillager' }] }),
    ).toThrow(/未知のルール効果/);
    expect(() =>
      coerceBehaviorRule({ description: 'x', when: [{ kind: 'moveBias', towards: 'partner' }], then: [{ kind: 'moveBias', towards: 'volcano' }] }),
    ).toThrow();
  });
});
