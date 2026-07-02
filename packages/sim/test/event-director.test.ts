import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  DEFAULT_CONFIG,
  EventDirector,
  TermMachine,
  StubBrain,
  EVENT_CATEGORIES,
  type World,
} from '../src/index.js';

function world(): World {
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.9 } });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 13, y: 12 }, activity: 'always', traits: { kindness: 0.9 } });
  const c = createVillager({ id: 'c', name: 'クマ', position: { x: 11, y: 12 }, activity: 'always', traits: { sociability: 0.9 } });
  return createWorld([a, b, c], DEFAULT_CONFIG, { year: 2026, month: 6 });
}

describe('EventDirector', () => {
  it('1 日で各イベント種別がクォータ (最低2) を満たす', () => {
    const w = world();
    const dir = new EventDirector({ rng: () => 0.5, maxRepsPerSegment: 1 });
    dir.resetDay();
    for (let seg = 0; seg < DEFAULT_CONFIG.segmentsPerDay; seg += 1) {
      dir.planSegment(w, DEFAULT_CONFIG.segmentsPerDay - seg);
    }
    for (const c of EVENT_CATEGORIES) expect(dir.dayCounts[c]).toBeGreaterThanOrEqual(2);
  });

  it('嫌がらせの実行者はピュアブリード (reformCount===0) を優先する', () => {
    const pure = createVillager({ id: 'p', name: 'ピュア', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.9 } });
    const reformed = createVillager({ id: 'r', name: 'カイ', position: { x: 13, y: 12 }, activity: 'always', traits: { aggression: 0.95 } });
    reformed.reformCount = 1;
    const w = createWorld([pure, reformed], DEFAULT_CONFIG, { year: 2026, month: 6 });
    const dir = new EventDirector({ rng: () => 0, maxRepsPerSegment: 1 }); // rng=0 → harass + 先頭
    const events = dir.planSegment(w, 12);
    expect(events[0]?.category).toBe('harass');
    expect(events[0]?.actor).toBe('p'); // 改変済み r ではなく pure
  });

  it('director 駆動 kishoTick は嫌がらせで事件を発火する', async () => {
    const w = world();
    const dir = new EventDirector({ rng: () => 0, maxRepsPerSegment: 1 });
    // 事件発火そのものを検証する: 小騒動 (§v1.4-B) は無効化。
    const tm = new TermMachine(w, new StubBrain(), { director: dir, minorConfig: { minorChance: 0, minorResidueChance: 0 } });
    tm.startDay();
    const r = await tm.kishoTick();
    expect(r.incidentStarted).toBe(true);
    expect(w.phase).toBe('sho');
    expect(w.incident?.involved.length).toBeGreaterThan(0);
  });
});
