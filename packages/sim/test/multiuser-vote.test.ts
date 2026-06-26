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

function harshWorld(): World {
  const x = createVillager({ id: 'x', name: 'ガオ', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.9 } });
  const y = createVillager({ id: 'y', name: 'リツ', position: { x: 13, y: 12 }, activity: 'always', traits: { discipline: 0.9 } });
  const z = createVillager({ id: 'z', name: 'ヤミ', position: { x: 11, y: 12 }, activity: 'always', traits: { ambition: 0.9 } });
  return createWorld([x, y, z], DEFAULT_CONFIG, { year: 2026, month: 6 });
}

/** 起→承 を回して foolish 段階 (転) まで進める。 */
async function driveToFoolish(tm: TermMachine, w: World): Promise<void> {
  tm.startDay();
  while (w.phase === 'kisho') await tm.kishoTick();
  for (let i = 0; i < 10 && w.phase === 'sho'; i += 1) await tm.shoStep();
}

describe('複数ユーザの通知投票 (重み合算 / 投票し直し)', () => {
  it('別 userId の票は合算される', async () => {
    const w = harshWorld();
    const tm = new TermMachine(w, new StubBrain(), {
      director: new EventDirector({ rng: () => 0, maxRepsPerSegment: 1 }),
    });
    await driveToFoolish(tm, w);
    expect(w.trial?.stage).toBe('foolish');

    tm.addUserVote('y', 'u1');
    tm.addUserVote('y', 'u2');
    expect(w.trial?.foolishVotes.y).toBe(2); // 2 人ぶん合算
    expect(w.trial?.votes.filter((v) => v.voter === 'user').length).toBe(2);
  });

  it('同じ userId の投票し直しは自分の前票だけ差し替える', async () => {
    const w = harshWorld();
    const tm = new TermMachine(w, new StubBrain(), {
      director: new EventDirector({ rng: () => 0, maxRepsPerSegment: 1 }),
    });
    await driveToFoolish(tm, w);

    tm.addUserVote('y', 'u1');
    tm.addUserVote('y', 'u2');
    tm.addUserVote('x', 'u1'); // u1 が y → x へ変更
    expect(w.trial?.foolishVotes.y).toBe(1); // u2 のぶんだけ残る
    expect(w.trial?.foolishVotes.x).toBe(1); // u1 の新票
    // user 票は合計 2 (u1 の最新 + u2)、重複しない。
    expect(w.trial?.votes.filter((v) => v.voter === 'user').length).toBe(2);
  });
});
