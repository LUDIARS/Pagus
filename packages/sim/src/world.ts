import type { World, WorldConfig, Villager, GridPos } from './types/index.js';
import type { EnvironmentView } from './brain.js';

export const DEFAULT_CONFIG: WorldConfig = {
  gridWidth: 24,
  gridHeight: 24,
  termDurationMs: 10 * 60 * 1000, // 10 分
  tickIntervalMs: 10 * 1000, // 10 秒
  damageThreshold: 10,
  trialWinningScore: 3,
};

/** 「周囲のキャラ」と見なすチェビシェフ距離。 */
export const NEARBY_RADIUS = 3;

export function createWorld(villagers: Villager[], config: WorldConfig = DEFAULT_CONFIG): World {
  return {
    config,
    term: 0,
    timeOfDay: 'morning',
    phase: 'idle',
    villagers: new Map(villagers.map((v) => [v.id, v])),
    incident: null,
    trial: null,
  };
}

export function aliveVillagers(world: World): Villager[] {
  return [...world.villagers.values()].filter((v) => v.alive);
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
    timeOfDay: world.timeOfDay,
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
