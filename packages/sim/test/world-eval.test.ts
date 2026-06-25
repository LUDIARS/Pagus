import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  aliveVillagers,
  DEFAULT_CONFIG,
  EventDirector,
  TermMachine,
  StubBrain,
  StubWorldBrain,
  type World,
} from '../src/index.js';

// 全グループが kill 寄り (攻撃性/規律/野心) になる村 → 死刑判決。
function harshWorld(): World {
  const x = createVillager({ id: 'x', name: 'ガオ', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.9 } });
  const y = createVillager({ id: 'y', name: 'リツ', position: { x: 13, y: 12 }, activity: 'always', traits: { discipline: 0.9 } });
  const z = createVillager({ id: 'z', name: 'ヤミ', position: { x: 11, y: 12 }, activity: 'always', traits: { ambition: 0.9 } });
  return createWorld([x, y, z], DEFAULT_CONFIG, { year: 2026, month: 6 });
}

// 全グループが spare 寄り (優しさ/社交/好奇心) になる村 → 教育判決。被告 a は攻撃性を持つ。
function gentleWorld(): World {
  const a = createVillager({ id: 'a', name: 'ハナ', position: { x: 12, y: 12 }, activity: 'always', traits: { kindness: 0.9, aggression: 0.3 } });
  const b = createVillager({ id: 'b', name: 'ソラ', position: { x: 13, y: 12 }, activity: 'always', traits: { sociability: 0.9 } });
  const c = createVillager({ id: 'c', name: 'ミオ', position: { x: 11, y: 12 }, activity: 'always', traits: { curiosity: 0.9 } });
  return createWorld([a, b, c], DEFAULT_CONFIG, { year: 2026, month: 6 });
}

/** 起→承→転→結(ketsuStep)まで決定的に駆動し、その日の裁判結末を捕捉させる。 */
async function driveToVerdict(tm: TermMachine, w: World): Promise<void> {
  tm.startDay();
  let started = false;
  for (let i = 0; i < 5 && !started; i += 1) started = (await tm.kishoTick()).incidentStarted;
  expect(started).toBe(true);
  for (let i = 0; i < 10 && w.phase === 'sho'; i += 1) await tm.shoStep();
  for (let i = 0; i < 12 && w.phase === 'ten'; i += 1) await tm.tenStep();
  expect(w.phase).toBe('ketsu');
  await tm.ketsuStep();
}

describe('世界側 LLM 日末評価', () => {
  it('死刑の日の後: 村の悪辣さが増え、偏り出生で人口が増える', async () => {
    const w = harshWorld();
    const dir = new EventDirector({ rng: () => 0, maxRepsPerSegment: 1 });
    const tm = new TermMachine(w, new StubBrain(), { director: dir, worldBrain: new StubWorldBrain(), rng: () => 0.42 });

    await driveToVerdict(tm, w);
    expect(w.trial?.verdict).toBe('death');

    const maliceBefore = w.reputation.malice;
    const aliveBefore = aliveVillagers(w).length;

    const ev = await tm.evaluateDay();
    expect(ev).not.toBeNull();
    expect(ev?.spawn).toBe(1);

    expect(w.reputation.malice).toBeGreaterThan(maliceBefore);
    expect(aliveVillagers(w).length).toBe(aliveBefore + (ev?.spawn ?? 0));
  });

  it('教育の日の後: 被告の攻撃性が下がり、村の善良さが増える', async () => {
    const w = gentleWorld();
    const dir = new EventDirector({ rng: () => 0, maxRepsPerSegment: 1 });
    const tm = new TermMachine(w, new StubBrain(), { director: dir, worldBrain: new StubWorldBrain(), rng: () => 0.42 });

    await driveToVerdict(tm, w);
    expect(w.trial?.verdict).toBe('spared');
    const defendantId = w.trial?.defendant as string;
    expect(defendantId).toBe('a');

    const aggressionBefore = w.villagers.get(defendantId)?.persona.traits.aggression ?? 0;
    const benevolenceBefore = w.reputation.benevolence;

    const ev = await tm.evaluateDay();
    expect(ev).not.toBeNull();

    expect(w.villagers.get(defendantId)?.persona.traits.aggression ?? 0).toBeLessThan(aggressionBefore);
    expect(w.reputation.benevolence).toBeGreaterThan(benevolenceBefore);
  });

  it('worldBrain 未設定なら日末評価は null (無言フォールバックしない)', async () => {
    const w = harshWorld();
    const dir = new EventDirector({ rng: () => 0, maxRepsPerSegment: 1 });
    const tm = new TermMachine(w, new StubBrain(), { director: dir });

    await driveToVerdict(tm, w);
    expect(await tm.evaluateDay()).toBeNull();
  });
});
