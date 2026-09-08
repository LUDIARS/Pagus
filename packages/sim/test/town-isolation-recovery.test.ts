import { describe, it, expect } from 'vitest';
import { createWorld, createVillager, DEFAULT_CONFIG } from '../src/index.js';
import type { World, Villager } from '../src/types/index.js';
import { changeHousing, type TownLife } from '../src/town-residency.js';
import {
  ISOLATION_PEACE_DAYS,
  advanceTownIsolationRecovery,
  recordTownHarassment,
} from '../src/town-isolation-recovery.js';

const PEACE_TICKS = ISOLATION_PEACE_DAYS * DEFAULT_CONFIG.segmentsPerDay;

function townWorld(life: Partial<TownLife> = {}): { world: World; v: Villager } {
  const v = createVillager({ id: 'a', name: 'アオ', position: { x: 1, y: 1 }, activity: 'always' });
  v.townLife = { housing: 'housed', homeId: 'home-1', reason: '割り当てられた家', occupation: 'carpenter', ...life };
  return { world: createWorld([v], DEFAULT_CONFIG), v };
}

/** Advance simulation time by whole days without running a full term machine tick. */
function passDays(world: World, days: number): void {
  world.term += days;
}

describe('隔離からの平穏による復帰', () => {
  it('6回の嫌がらせで隔離され、隔離前の住居状態を保存する', () => {
    const { world, v } = townWorld();
    for (let i = 0; i < 6; i++) recordTownHarassment(world, v);
    expect(v.townLife?.housing).toBe('isolated');
    expect(v.townLife?.isolationReturnHousing).toBe('housed');
    expect(v.townLife?.formerHomeId).toBe('home-1');
  });

  it('5回では隔離されない', () => {
    const { world, v } = townWorld();
    for (let i = 0; i < 5; i++) recordTownHarassment(world, v);
    expect(v.townLife?.housing).toBe('housed');
  });

  it('3日間の平穏で自宅へ復帰し、嫌がらせ回数を消す', () => {
    const { world, v } = townWorld();
    for (let i = 0; i < 6; i++) recordTownHarassment(world, v);
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('housed');
    expect(v.townLife?.homeId).toBe('home-1');
    expect(v.eventParams['townHarassment']).toBeUndefined();
    expect(v.townLife?.isolationReturnHousing).toBeUndefined();
  });

  it('3日未満では隔離のまま', () => {
    const { world, v } = townWorld();
    for (let i = 0; i < 6; i++) recordTownHarassment(world, v);
    passDays(world, ISOLATION_PEACE_DAYS - 1);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('isolated');
  });

  it('追加の嫌がらせは平穏期間を数え直す', () => {
    const { world, v } = townWorld();
    for (let i = 0; i < 6; i++) recordTownHarassment(world, v);
    passDays(world, ISOLATION_PEACE_DAYS - 1);
    recordTownHarassment(world, v);
    passDays(world, 1);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('isolated');
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('housed');
  });

  it('平穏を挟めば嫌がらせ回数は累積せず隔離されない', () => {
    const { world, v } = townWorld();
    for (let i = 0; i < 5; i++) recordTownHarassment(world, v);
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.eventParams['townHarassment']).toBeUndefined();
    for (let i = 0; i < 5; i++) recordTownHarassment(world, v);
    expect(v.townLife?.housing).toBe('housed');
  });

  it('家を失っていた住民は再建待ちへ戻る', () => {
    const { world, v } = townWorld({ housing: 'displaced', homeId: 'shelter', formerHomeId: 'home-2' });
    for (let i = 0; i < 6; i++) recordTownHarassment(world, v);
    expect(v.townLife?.isolationReturnHousing).toBe('displaced');
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('displaced');
    expect(v.townLife?.formerHomeId).toBe('home-2');
  });

  it('区画を持たず野営地にいた「家がある」住民は建設待ちへ戻る (throw しない)', () => {
    const { world, v } = townWorld({ housing: 'housed', homeId: 'shelter' });
    for (let i = 0; i < 6; i++) recordTownHarassment(world, v);
    expect(v.townLife?.isolationReturnHousing).toBe('housed');
    expect(v.townLife?.formerHomeId).toBeUndefined();
    passDays(world, ISOLATION_PEACE_DAYS);
    expect(() => advanceTownIsolationRecovery(world)).not.toThrow();
    expect(v.townLife?.housing).toBe('unhoused');
  });

  it('旧セーブは最初のtickから3日を数え、即時解除しない', () => {
    const { world, v } = townWorld();
    changeHousing(v, 'isolated', '以前の迫害によって離れで暮らしている');
    delete v.townLife!.isolationReturnHousing;
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('isolated');
    expect(v.eventParams['townLastHarassmentTick']).toBe(0);
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('displaced');
  });

  it('死亡した住民は復帰させない', () => {
    const { world, v } = townWorld();
    for (let i = 0; i < 6; i++) recordTownHarassment(world, v);
    v.alive = false;
    passDays(world, ISOLATION_PEACE_DAYS);
    advanceTownIsolationRecovery(world);
    expect(v.townLife?.housing).toBe('isolated');
  });
});
