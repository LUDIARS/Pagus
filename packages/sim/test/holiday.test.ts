import { describe, it, expect } from 'vitest';
import {
  holidayName,
  vernalEquinoxDay,
  autumnalEquinoxDay,
  createWorld,
  createVillager,
  TermMachine,
  StubBrain,
  StubWorldBrain,
  DEFAULT_CONFIG,
  type World,
} from '../src/index.js';

describe('holidayName / 春分・秋分の天文計算', () => {
  it('固定祝日を返す', () => {
    expect(holidayName(2026, 1, 1)).toBe('元日');
    expect(holidayName(2026, 5, 5)).toBe('こどもの日');
    expect(holidayName(2026, 7, 7)).toBeNull();
  });

  it('春分/秋分は年から算出する (2026: 3/20, 9/23)', () => {
    expect(vernalEquinoxDay(2026)).toBe(20);
    expect(autumnalEquinoxDay(2026)).toBe(23);
    expect(holidayName(2026, 3, 20)).toBe('春分の日');
    expect(holidayName(2026, 9, 23)).toBe('秋分の日');
    // 近似ではなく年依存: 2024 の春分は 3/20。
    expect(holidayName(2024, 3, vernalEquinoxDay(2024))).toBe('春分の日');
    expect(holidayName(2026, 3, 19)).toBeNull();
  });
});

function worldOnEve(): World {
  const a = createVillager({ id: 'a', name: 'ハナ', position: { x: 1, y: 1 }, activity: 'always' });
  // 5/2 の日末 (advance) に置く → advanceDay で 5/3 (憲法記念日) になる。
  return createWorld([a], DEFAULT_CONFIG, { year: 2026, month: 5, dayOfMonth: 2 });
}

describe('祝日イベントの発火', () => {
  it('advanceDay が祝日を返し fireHolidayEvent が評判を動かす', async () => {
    const world = worldOnEve();
    world.phase = 'advance';
    const tm = new TermMachine(world, new StubBrain(), { worldBrain: new StubWorldBrain() });

    const r = tm.advanceDay();
    expect(r.holiday).toBe('憲法記念日');

    const before = world.reputation.vitality;
    const ev = await tm.fireHolidayEvent(r.holiday as string);
    expect(ev).not.toBeNull();
    expect(ev?.narrative).toContain('憲法記念日');
    expect(world.reputation.vitality).toBeGreaterThan(before);
  });

  it('worldBrain 無しなら祝日イベントは null (発火しない)', async () => {
    const world = worldOnEve();
    const tm = new TermMachine(world, new StubBrain());
    expect(await tm.fireHolidayEvent('元日')).toBeNull();
  });
});
