import type { GridPos, WorldConfig } from '@pagus/sim';
import type { Vec3 } from './mesh-primitives.js';

export const TOWN_SPAN = 36;
export function townPoint(config: Pick<WorldConfig, 'gridWidth' | 'gridHeight'>, p: GridPos): Vec3 {
  return [(p.x / Math.max(1, config.gridWidth - 1) - .5) * TOWN_SPAN, 0, (p.y / Math.max(1, config.gridHeight - 1) - .5) * TOWN_SPAN];
}
