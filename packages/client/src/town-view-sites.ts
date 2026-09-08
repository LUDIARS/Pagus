import { MAX_VISIBLE_BUILDINGS, townMap, type TownArea, type TownSite, type WorldConfig } from '@pagus/sim';
import { townAreaCentre } from './town-area-centre.js';

/** Stable area-centred selection, shared by geometry and clickable labels. */
export function townViewSites(config: WorldConfig, area: TownArea): TownSite[] {
  const { x, y } = townAreaCentre(config, area);
  const distance = (position: { x: number; y: number }): number => (position.x - x) ** 2 + (position.y - y) ** 2;
  return townMap(config).sites.sort((a, b) => distance(a.position) - distance(b.position) || a.id.localeCompare(b.id)).slice(0, MAX_VISIBLE_BUILDINGS);
}
