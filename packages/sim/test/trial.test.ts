import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  DEFAULT_CONFIG,
  EventDirector,
  TermMachine,
  StubBrain,
  type World,
} from '../src/index.js';

// 全グループが kill 寄り (攻撃性/規律/野心) になる村。
function harshWorld(): World {
  const x = createVillager({ id: 'x', name: 'ガオ', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.9 } });
  const y = createVillager({ id: 'y', name: 'リツ', position: { x: 13, y: 12 }, activity: 'always', traits: { discipline: 0.9 } });
  const z = createVillager({ id: 'z', name: 'ヤミ', position: { x: 11, y: 12 }, activity: 'always', traits: { ambition: 0.9 } });
  return createWorld([x, y, z], DEFAULT_CONFIG, { year: 2026, month: 6 });
}

describe('投票裁判', () => {
  it('全グループが kill 投票 → 死刑 → 被告は追放される', async () => {
    const w = harshWorld();
    const dir = new EventDirector({ rng: () => 0, maxRepsPerSegment: 1 }); // harass + 先頭
    const tm = new TermMachine(w, new StubBrain(), { director: dir });
    tm.startDay();

    let started = false;
    for (let i = 0; i < 5 && !started; i += 1) started = (await tm.kishoTick()).incidentStarted;
    expect(started).toBe(true);

    for (let i = 0; i < 10 && w.phase === 'sho'; i += 1) await tm.shoStep();
    for (let i = 0; i < 12 && w.phase === 'ten'; i += 1) await tm.tenStep();

    expect(w.phase).toBe('ketsu');
    expect(w.trial?.defendant).toBe('x'); // 最も攻撃的
    expect(w.trial?.verdict).toBe('death');

    await tm.ketsuStep();
    tm.applyReform();
    expect(w.villagers.get('x')?.alive).toBe(false); // 追放
  });

  it('addUserVote はユーザの 1 票を集計へ加える', async () => {
    const w = harshWorld();
    const dir = new EventDirector({ rng: () => 0, maxRepsPerSegment: 1 });
    const tm = new TermMachine(w, new StubBrain(), { director: dir });
    tm.startDay();
    while (w.phase === 'kisho') await tm.kishoTick();
    for (let i = 0; i < 10 && w.phase === 'sho'; i += 1) await tm.shoStep();
    expect(w.phase).toBe('ten');
    expect(w.trial?.stage).toBe('foolish');
    tm.addUserVote('y');
    expect(w.trial?.foolishVotes.y).toBe(1);
    expect(w.trial?.votes.some((v) => v.voter === 'user')).toBe(true);
  });

  it('recovers a foolish trial whose pending groups were exhausted', async () => {
    const w = harshWorld();
    w.phase = 'ten';
    w.incident = {
      id: 'inc_stuck',
      perpetrator: 'x',
      involved: ['y'],
      description: 'stuck trial',
      damage: 10,
      steps: [],
      resolved: true,
    };
    w.trial = {
      incidentId: 'inc_stuck',
      judge: { kind: 'nekomori' },
      candidates: ['x', 'y'],
      stage: 'foolish',
      pendingGroups: [],
      foolishVotes: { x: 3 },
      defendant: null,
      fateVotes: { kill: 0, spare: 0 },
      votes: [],
      verdict: null,
    };

    const tm = new TermMachine(w, new StubBrain());
    await tm.tenStep();

    expect(w.phase).toBe('ten');
    expect(w.trial?.stage).toBe('fate');
    expect(w.trial?.defendant).toBe('x');
    expect(w.trial?.pendingGroups.length).toBeGreaterThan(0);
  });
});
