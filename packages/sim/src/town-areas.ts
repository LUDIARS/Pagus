import type { GridPos, WorldConfig } from './types/index.js';

export const TOWN_AREAS = ['north-west', 'north', 'north-east', 'west', 'plaza', 'east', 'south-west', 'south', 'south-east'] as const;
export type TownArea = typeof TOWN_AREAS[number];
/** One-cell halo: loaded before crossing a district boundary. */
export function neighboringTownAreas(area: TownArea, radius: 1 | 2 = 1): TownArea[] {
  const index = TOWN_AREAS.indexOf(area);
  if (index < 0) throw new Error(`Unknown town area: ${String(area)}`);
  return TOWN_AREAS.filter((_, i) => Math.abs(i%3-index%3) <= radius && Math.abs(Math.floor(i/3)-Math.floor(index/3)) <= radius);
}
export function isTownArea(value: unknown): value is TownArea {
  return typeof value === 'string' && TOWN_AREAS.some((area) => area === value);
}
export function townAreaAt(config: Pick<WorldConfig, 'gridWidth' | 'gridHeight'>, position: GridPos): TownArea {
  const x = Math.max(0, Math.min(2, Math.floor(position.x * 3 / config.gridWidth)));
  const y = Math.max(0, Math.min(2, Math.floor(position.y * 3 / config.gridHeight)));
  return TOWN_AREAS[y * 3 + x] ?? 'plaza';
}
