import { describe, it, expect } from 'vitest';
import { createWorld, createVillager, DEFAULT_CONFIG } from '../src/index.js';
import type { World, Villager } from '../src/types/index.js';
import { changeHousing, type TownLife } from '../src/town-residency.js';
import {
  ISOLATION_PEACE_DAYS,
  advanceTownIsolationRecovery,
  recordTownHarassment,
} from '../src/town-isolation-recovery.js';

function townWorld(life: Partial<TownLife> = {}): { world: World; v: Villager } {
  const v = createVillager({ id: 'a', name: 'アオ', position: { x: 1, y: 1 }, activity: 'always' });
  v.townLife = { housing: 'housed', homeId: 'home-1', reason: '割り当てられた家', occupation: 'carpenter', ...life };
  const world = createWorld([v], DEFAULT_CONFIG);
  // Policy version 2 migration releases the legacy population once and grants a
  // grace period; run it up front so each case starts from the current policy.
  advanceTownIsolationRecovery(world);
  passDays(world, ISOLATION_PEACE_DAYS);
  return { world, v };
}

/** Advance simulation time by whole days without running a full term machine tick. */
function passDays(world: World, days: number): void {
  world.term += days;
}

/**
 * Harass across distinct time segments of one day, as the policy window requires,
 * then settle on the next day boundary so peace is counted in whole days.
 */
function harass(world: World, v: Villager, times: number): void {
  for (let i = 0; i < times; i++) {
    world.calendar.segment = i % world.config.segmentsPerDay;
    recordTownHarassment(world, v);
  }
  world.calendar.segment = 0;
  passDays(world, 1);
}

describe('隔離からの平穏による復帰', () => {
  it('6回の嫌がらせで隔離され、隔離前の住居状態を保存する', () => {
    const { world, v } = townWorld();
    harass(world, v, 6);
    expect(v.townLife?.housing).toBe('isolated');
    expect(v.townLife?.isolationReturnHousing).toBe('housed');
    expect(v.townLife?.formerHomeId).toBe('home-1');
  });

  it('5回では隔離されない', () => {
    const { world, v } = townWorld();
    harass(world, v, 5);
    expect(v.townLife?.housing).toBe('housed');
  });

  // 恐怖は被害者側に上がる経路が他に無いため、この加算が無いと隔離は到達不能になる。
  it('嫌がらせは被害者の恐怖を高め、6回目で閾値に届く', () => {
    const { world, v } = townWorld();
    harass(world, v, 5);
    expect(v.emotion.axes['fear'] ?? 0).toBeLessThan(0.8);
    harass(world, v, 6);
    expect(v.emotion.axes['fear'] ?? 0).toBeGreaterThanOrEqual(0.8);
  });

  it('恐怖が閾値に届かなければ回数を満たしても隔離されない', () => {
    const { world, v } = townWorld();
    // 落ち着いた住民は同じ回数を受けても閾値へ届かない。
    v.emotion.axes['fear'] = -0.5;
    harass(world, v, 6);
    expect(v.emotion.axes['fear'] ?? 0).toBeLessThan(0.8);
    expect(v.townLife?.housing).toBe('housed');
  });

  it('3日間の平穏で自宅へ復帰し、嫌がらせ回数を消す', () => {
    const { world, v } = townWorld();
    harass(world, v, 6);
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('housed');
    expect(v.townLife?.homeId).toBe('home-1');
    expect(v.eventParams['townHarassment']).toBeUndefined();
    expect(v.townLife?.isolationReturnHousing).toBeUndefined();
  });

  it('3日未満では隔離のまま', () => {
    const { world, v } = townWorld();
    harass(world, v, 6);
    passDays(world, ISOLATION_PEACE_DAYS - 1);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('isolated');
  });

  it('追加の嫌がらせは平穏期間を数え直す', () => {
    const { world, v } = townWorld();
    harass(world, v, 6);
    passDays(world, ISOLATION_PEACE_DAYS - 1);
    harass(world, v, 1);
    passDays(world, 1);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('isolated');
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('housed');
  });

  it('平穏を挟めば嫌がらせ回数は累積せず隔離されない', () => {
    const { world, v } = townWorld();
    harass(world, v, 5);
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.eventParams['townHarassment']).toBeUndefined();
    harass(world, v, 5);
    expect(v.townLife?.housing).toBe('housed');
  });

  it('解除直後の猶予期間中は嫌がらせを数え直さない', () => {
    const { world, v } = townWorld();
    harass(world, v, 6);
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('housed');
    harass(world, v, 6);
    expect(v.townLife?.housing).toBe('housed');
    expect(v.eventParams['townHarassment']).toBeUndefined();
  });

  it('家を失っていた住民は再建待ちへ戻る', () => {
    const { world, v } = townWorld({ housing: 'displaced', homeId: 'shelter', formerHomeId: 'home-2' });
    harass(world, v, 6);
    expect(v.townLife?.isolationReturnHousing).toBe('displaced');
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('displaced');
    expect(v.townLife?.formerHomeId).toBe('home-2');
  });

  it('区画を持たず野営地にいた「家がある」住民は建設待ちへ戻る (throw しない)', () => {
    const { world, v } = townWorld({ housing: 'housed', homeId: 'shelter' });
    harass(world, v, 6);
    expect(v.townLife?.isolationReturnHousing).toBe('housed');
    expect(v.townLife?.formerHomeId).toBeUndefined();
    passDays(world, ISOLATION_PEACE_DAYS);
    expect(() => advanceTownIsolationRecovery(world)).not.toThrow();
    expect(v.townLife?.housing).toBe('unhoused');
  });

  it('旧セーブの隔離は移行時に一度だけ解除される', () => {
    const v = createVillager({ id: 'a', name: 'アオ', position: { x: 1, y: 1 }, activity: 'always' });
    v.townLife = { housing: 'housed', homeId: 'home-1', reason: '割り当てられた家', occupation: 'carpenter' };
    changeHousing(v, 'isolated', '以前の迫害によって離れで暮らしている');
    delete v.townLife.isolationReturnHousing;
    const world = createWorld([v], DEFAULT_CONFIG);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('displaced');
    expect(v.townLife?.formerHomeId).toBe('home-1');
    expect(v.eventParams['townIsolationPolicyVersion']).toBe(2);
  });

  it('死亡した住民は復帰させない', () => {
    const { world, v } = townWorld();
    harass(world, v, 6);
    v.alive = false;
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('isolated');
  });
});
