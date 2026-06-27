import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  StubBrain,
  TermMachine,
  DEFAULT_CONFIG,
  type World,
} from '../src/index.js';

function twoAnimalWorld(month = 6): World {
  // どちらも常時活動 (always) にして睡眠で tick がスキップされないようにする。
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, species: '猫', activity: 'always', traits: { aggression: 0.6 } });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 13, y: 12 }, species: '兎', activity: 'always' });
  return createWorld([a, b], { ...DEFAULT_CONFIG, damageThreshold: 8 }, { year: 2026, month });
}

describe('TermMachine 起承転結 (セグメント駆動)', () => {
  it('起 → 承 → 転 → 結 → 改変 → 起へ復帰 を一巡できる', async () => {
    const world = twoAnimalWorld();
    // 日常エンジン (LLM 非依存) が 1 行動目で事件化するよう dailyTriggerAfter:1。
    // 承の被害量は StubBrain.advanceIncident (damagePerStep) が決める。
    const tm = new TermMachine(world, new StubBrain({ damagePerStep: 4 }), { dailyTriggerAfter: 1 });

    tm.startDay();
    expect(world.phase).toBe('kisho');

    let started = false;
    for (let i = 0; i < 10 && !started; i += 1) {
      started = (await tm.kishoTick()).incidentStarted;
    }
    expect(started).toBe(true);
    expect(world.phase).toBe('sho');
    expect(world.incident?.perpetrator).toBe('a');
    expect(world.incident?.involved).toContain('b');

    for (let i = 0; i < 10 && world.phase === 'sho'; i += 1) await tm.shoStep();
    expect(world.phase).toBe('ten');
    expect(world.incident?.resolved).toBe(true);

    for (let i = 0; i < 10 && world.phase === 'ten'; i += 1) await tm.tenStep();
    expect(world.phase).toBe('ketsu');
    // 被告は最も攻撃的な a。kill(攻撃性群) と spare(優しさ群) が同数 → 活かす。
    expect(world.trial?.defendant).toBe('a');
    expect(world.trial?.verdict).toBe('spared');

    await tm.ketsuStep();
    expect(world.phase).toBe('reform');

    tm.applyReform();
    expect(world.phase).toBe('kisho'); // その日の残りセグメントへ復帰
    const perp = world.villagers.get('a');
    expect(perp?.appearance.body).toBe('machine'); // 活かされ → 強制教育で改変
    expect(perp?.persona.traits.aggression).toBe(-0.5);
    expect(perp?.reformCount).toBe(1);
    expect(world.incident).toBeNull();
    expect(world.trial).toBeNull();
  });

  it('12 セグメントを消化すると日末→翌日へ進む', () => {
    const world = twoAnimalWorld(6); // 6月 = 30日
    const tm = new TermMachine(world, new StubBrain());
    tm.startDay();
    for (let i = 0; i < DEFAULT_CONFIG.segmentsPerDay - 1; i += 1) {
      expect(tm.advanceSegment().dayEnded).toBe(false);
    }
    expect(tm.advanceSegment().dayEnded).toBe(true);
    expect(world.phase).toBe('advance');

    const r = tm.advanceDay();
    expect(world.term).toBe(1);
    expect(world.calendar.dayOfMonth).toBe(2);
    expect(world.calendar.segment).toBe(0);
    expect(world.phase).toBe('idle');
    expect(r.monthRolled).toBe(false);
  });

  it('月末で月遷移し季節も更新される (2月末→3月=春)', () => {
    const world = twoAnimalWorld(2); // 2月 = 28日 (2026 非閏)
    world.calendar.dayOfMonth = 28;
    const tm = new TermMachine(world, new StubBrain());
    world.phase = 'advance';
    const r = tm.advanceDay();
    expect(r.monthRolled).toBe(true);
    expect(world.calendar.month).toBe(3);
    expect(world.calendar.dayOfMonth).toBe(1);
    expect(world.calendar.daysInMonth).toBe(31);
    expect(world.calendar.season).toBe('spring');
  });

  it('夜行性のどうぶつは昼セグメントで行動しない', async () => {
    const owl = createVillager({ id: 'o', name: 'フク', position: { x: 12, y: 12 }, species: '梟', activity: 'nocturnal' });
    const world = createWorld([owl], DEFAULT_CONFIG, { year: 2026, month: 6 });
    world.calendar.segment = 6; // 昼
    const tm = new TermMachine(world, new StubBrain());
    tm.startDay();
    const r = await tm.kishoTick();
    expect(r.actions).toHaveLength(0); // 寝ている
  });
});
