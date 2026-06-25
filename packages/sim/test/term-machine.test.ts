import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  StubBrain,
  TermMachine,
  DEFAULT_CONFIG,
  type World,
} from '../src/index.js';

function twoVillagerWorld(): World {
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, traits: { aggression: 0.6 } });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 13, y: 12 } });
  return createWorld([a, b], { ...DEFAULT_CONFIG, damageThreshold: 8 });
}

describe('TermMachine 起承転結', () => {
  it('起 → 承 → 転 → 結 → 改変 → 時間進行 を一巡できる', async () => {
    const world = twoVillagerWorld();
    const tm = new TermMachine(world, new StubBrain({ triggerAfter: 1, damagePerStep: 4 }));

    tm.start();
    expect(world.phase).toBe('kisho');

    // 起: 事件が発火するまで tick
    let started = false;
    for (let i = 0; i < 10 && !started; i += 1) {
      started = (await tm.kishoTick()).incidentStarted;
    }
    expect(started).toBe(true);
    expect(world.phase).toBe('sho');
    expect(world.incident?.perpetrator).toBe('a');
    expect(world.incident?.involved).toContain('b');

    // 承: 被害が閾値を超えるまで
    for (let i = 0; i < 10 && world.phase === 'sho'; i += 1) {
      await tm.shoStep();
    }
    expect(world.phase).toBe('ten');
    expect(world.incident?.resolved).toBe(true);
    expect(world.trial).not.toBeNull();

    // 転: 3 点先取まで
    for (let i = 0; i < 10 && world.phase === 'ten'; i += 1) {
      await tm.tenStep();
    }
    expect(world.phase).toBe('ketsu');
    // StubBrain は常に victim 勝利 → 完封なので死刑
    expect(world.trial?.verdict).toBe('death');

    // 結: 教育内容決定
    await tm.ketsuStep();
    expect(world.phase).toBe('reform');

    // 改変適用: 加害者が機械の体に矯正される
    tm.applyReform();
    expect(world.phase).toBe('advance');
    const perp = world.villagers.get('a');
    expect(perp?.appearance.body).toBe('machine');
    expect(perp?.persona.traits.aggression).toBe(-0.5);
    expect(perp?.reformCount).toBe(1);
    expect(world.incident).toBeNull();
    expect(world.trial).toBeNull();

    // 時間進行
    tm.advanceTime();
    expect(world.timeOfDay).toBe('noon');
    expect(world.phase).toBe('idle');
  });

  it('夜→朝の折返しでターム番号が進む', () => {
    const world = twoVillagerWorld();
    const tm = new TermMachine(world, new StubBrain());
    world.phase = 'advance';
    world.timeOfDay = 'night';
    tm.advanceTime();
    expect(world.timeOfDay).toBe('morning');
    expect(world.term).toBe(1);
  });
});
