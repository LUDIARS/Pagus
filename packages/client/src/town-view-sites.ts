import { neighboringTownAreas, townAreaAt, townMap, type TownArea, type TownSite, type WorldConfig } from '@pagus/sim';
import { townAreaCentre } from './town-area-centre.js';

/** Stable area-centred selection, shared by geometry and clickable labels. */
export function townViewSites(config: WorldConfig, area: TownArea, radius: 1 | 2 = 1): TownSite[] {
  const { x, y } = townAreaCentre(config, area);
  const distance = (position: { x: number; y: number }): number => (position.x - x) ** 2 + (position.y - y) ** 2;
  const neighbors = neighboringTownAreas(area, radius);
  return townMap(config).sites.filter(site => neighbors.includes(townAreaAt(config, site.position)))
    .sort((a, b) => distance(a.position) - distance(b.position) || a.id.localeCompare(b.id));
}
