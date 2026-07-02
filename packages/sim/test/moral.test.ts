import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  StubBrain,
  TermMachine,
  DEFAULT_CONFIG,
  type World,
  type Incident,
  type TrialState,
} from '../src/index.js';

// 厳格軸 (aggression) のみの村 = StubBrain の fate 投票は必ず kill。
function harshWorld(): World {
  const a = createVillager({ id: 'a', name: 'ガオ', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.9 } });
  const b = createVillager({ id: 'b', name: 'リツ', position: { x: 13, y: 12 }, activity: 'always', traits: { aggression: 0.8 } });
  return createWorld([a, b], DEFAULT_CONFIG, { year: 2026, month: 6 });
}

/** fate 段階 (残り 1 グループ) の裁判を直接組む。 */
function fateWorld(world: World): void {
  const incident: Incident = {
    id: 'inc_m',
    perpetrator: 'a',
    involved: ['b'],
    description: 'テスト事件',
    damage: 10,
    steps: [],
    resolved: true,
    origin: 'organic',
  };
  const trial: TrialState = {
    incidentId: 'inc_m',
    judge: { kind: 'nekomori' },
    candidates: ['a'],
    stage: 'fate',
    pendingGroups: ['aggression'],
    foolishVotes: {},
    defendant: 'a',
    fateVotes: { kill: 0, spare: 0 },
    votes: [],
    verdict: null,
  };
  world.incident = incident;
  world.trial = trial;
  world.phase = 'ten';
}

describe('モラルダイヤル (§v1.4-D)', () => {
  it('balanced (既定): kill 多数なら死刑', async () => {
    const world = harshWorld();
    fateWorld(world);
    const tm = new TermMachine(world, new StubBrain(), {
      trialComposeConfig: { witnessMax: 0, witnessWeight: 0, revealChance: 0 },
    });
    await tm.tenStep();
    expect(world.trial?.verdict).toBe('death');
  });

  it('wholesome: kill 多数でも判決は必ず教育 (死刑無効)', async () => {
    const world = harshWorld();
    fateWorld(world);
    const tm = new TermMachine(world, new StubBrain(), {
      moral: 'wholesome',
      trialComposeConfig: { witnessMax: 0, witnessWeight: 0, revealChance: 0 },
    });
    await tm.tenStep();
    expect(world.trial?.fateVotes.kill).toBeGreaterThan(0); // 票は記録される
    expect(world.trial?.verdict).toBe('spared');
  });
});
