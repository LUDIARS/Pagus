import type { World, WorldConfig, Villager, GridPos, Calendar } from './types/index.js';
import type { EnvironmentView } from './brain.js';
import { season, daysInMonth, timeOfDayForSegment, isAwake } from './calendar.js';

export const DEFAULT_CONFIG: WorldConfig = {
  gridWidth: 24,
  gridHeight: 24,
  segmentsPerDay: 12,
  damageThreshold: 10,
  trialWinningScore: 3,
};

/** 「周囲のキャラ」と見なすチェビシェフ距離。 */
export const NEARBY_RADIUS = 3;

export interface CalendarInit {
  year: number;
  month: number;
  dayOfMonth?: number;
  segment?: number;
}

export function makeCalendar(init: CalendarInit): Calendar {
  return {
    year: init.year,
    month: init.month,
    dayOfMonth: init.dayOfMonth ?? 1,
    daysInMonth: daysInMonth(init.year, init.month),
    segment: init.segment ?? 0,
    season: season(init.month),
  };
}

export function createWorld(
  villagers: Villager[],
  config: WorldConfig = DEFAULT_CONFIG,
  calendar: CalendarInit = { year: 2026, month: 1 },
): World {
  return {
    config,
    term: 0,
    calendar: makeCalendar(calendar),
    phase: 'idle',
    villagers: new Map(villagers.map((v) => [v.id, v])),
    incident: null,
    trial: null,
  };
}

export function aliveVillagers(world: World): Villager[] {
  return [...world.villagers.values()].filter((v) => v.alive);
}

/** いま起きている (行動できる) どうぶつ。 */
export function awakeVillagers(world: World): Villager[] {
  const { segment } = world.calendar;
  const { segmentsPerDay } = world.config;
  return aliveVillagers(world).filter((v) => isAwake(v.activity, segment, segmentsPerDay));
}

function chebyshev(a: GridPos, b: GridPos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** 位置からの場所ラベル (環境の言語化)。中央は広場、外周は村はずれ。 */
export function placeAt(world: World, pos: GridPos): string {
  const { gridWidth, gridHeight } = world.config;
  const cx = gridWidth / 2;
  const cy = gridHeight / 2;
  const dx = Math.abs(pos.x - cx) / cx;
  const dy = Math.abs(pos.y - cy) / cy;
  const r = Math.max(dx, dy);
  if (r < 0.34) return '広場';
  if (r < 0.7) return '住宅地';
  return '村はずれ';
}

/** 環境=プログラムが算出する。Brain へはこのビューだけを渡す。 */
export function environmentView(world: World, villager: Villager): EnvironmentView {
  const nearby = aliveVillagers(world)
    .filter((v) => v.id !== villager.id && chebyshev(v.position, villager.position) <= NEARBY_RADIUS)
    .map((v) => ({ id: v.id, name: v.name, pos: { ...v.position } }));
  return {
    position: { ...villager.position },
    place: placeAt(world, villager.position),
    timeOfDay: timeOfDayForSegment(world.calendar.segment, world.config.segmentsPerDay),
    nearby,
  };
}

/** グリッド内へ座標をクランプする。 */
export function clampPos(world: World, pos: GridPos): GridPos {
  return {
    x: Math.min(Math.max(0, Math.round(pos.x)), world.config.gridWidth - 1),
    y: Math.min(Math.max(0, Math.round(pos.y)), world.config.gridHeight - 1),
  };
}
