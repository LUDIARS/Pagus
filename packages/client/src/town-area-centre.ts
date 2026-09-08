import { TOWN_AREAS, type GridPos, type TownArea, type WorldConfig } from '@pagus/sim';

/**
 * Grid centre of one 3x3 district. Both the visible-building selection and the
 * camera focus derive from this, so they can never disagree about where an area is.
 */
export function townAreaCentre(config: Pick<WorldConfig, 'gridWidth' | 'gridHeight'>, area: TownArea): GridPos {
  const index = TOWN_AREAS.indexOf(area);
  // 設定不備の無言フォールバック禁止 (RULE_CODE §7.1): an off-map centre would
  // silently pick the wrong ten buildings and aim the camera outside the town.
  if (index < 0) throw new Error(`Unknown town area: ${String(area)}`);
  return {
    x: (index % 3 + .5) * config.gridWidth / 3,
    y: (Math.floor(index / 3) + .5) * config.gridHeight / 3,
  };
}
