import { townMap, townRoadCells, mixedPartsFor, type WireWorld, type TownArea } from '@pagus/sim';
import { townViewSites } from './town-view-sites.js';
import type { ShapePart } from './mesh-primitives.js';
import { townPoint, TOWN_SPAN } from './town-coordinates.js';
import { townBuilding } from './town-buildings.js';
import { terrainHeight } from './town-terrain.js';

/** Street paving and geometry consume the same solid cells as navigation. */
export function townScenery(world: WireWorld, area: TownArea, damagedHomes: ReadonlySet<string> = new Set()): ShapePart[] {
  const config = world.config;
  const map = townMap(config);
  const halfCell = Math.min(TOWN_SPAN / Math.max(1, map.width - 1), TOWN_SPAN / Math.max(1, map.height - 1)) / 2;
  const parts: ShapePart[] = [];
  for (const key of townRoadCells(map)) {
    const p = { x: key % map.width, y: Math.floor(key / map.width) };
    const [x, , z] = townPoint(config, p);
    for (const dx of [-.5, .5]) for (const dz of [-.5, .5]) {
      const xx = x + dx * halfCell, zz = z + dz * halfCell;
      const tint = ((key + (dx > 0 ? 1 : 0) + (dz > 0 ? 2 : 0)) % 4) * .025;
      parts.push({ center: [xx, terrainHeight(xx, zz), zz], radius: [halfCell * .47, .035, halfCell * .47],
        color: [.73+tint, .70+tint, .62+tint], box: true });
    }
  }
  for (const site of townViewSites(config, area)) {
    const owner = world.villagers.find((v) => v.alive && (v.townLife?.homeId === site.id || v.townLife?.formerHomeId === site.id));
    const construction = world.villagers.find((v) => v.alive && v.townLife?.buildHomeId === site.id);
    parts.push(...townBuilding(site, townPoint(config, site.position), halfCell, damagedHomes.has(site.id) || !!construction, owner ? mixedPartsFor(owner) : []));
  }
  for (let i = -17; i <= 17; i += 4) {
    for (const z of [-19, 19]) {
      parts.push({ center: [i, terrainHeight(i,z)+.6, z], radius: [.12, .65, .12], color: [.41, .29, .2], box: true });
      parts.push({ center: [i, terrainHeight(i,z)+1.6, z], radius: [.65, .95, .65], color: [.26, .43, .31] });
    }
  }
  return parts;
}
