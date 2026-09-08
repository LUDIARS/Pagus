import { townMap, townRoute, townSite, mixedPartsFor, type WireWorld, type TownArea } from '@pagus/sim';
import { townViewSites } from './town-view-sites.js';
import type { ShapePart } from './mesh-primitives.js';
import { townPoint, TOWN_SPAN } from './town-coordinates.js';
import { townBuilding } from './town-buildings.js';

/** Street paving and geometry consume the same solid cells as navigation. */
export function townScenery(world: WireWorld, area: TownArea, damagedHomes: ReadonlySet<string> = new Set()): ShapePart[] {
  const config = world.config;
  const map = townMap(config);
  const halfCell = Math.min(TOWN_SPAN / Math.max(1, map.width - 1), TOWN_SPAN / Math.max(1, map.height - 1)) / 2;
  const parts: ShapePart[] = [{ center: [0, -.3, 0], radius: [19, .25, 19], color: [.43, .59, .39], box: true }];
  const plaza = townPoint(config, townSite(map, 'fountain').position);
  parts.push({ center: [plaza[0], -.015, plaza[2]], radius: [3.7, .025, 3.7], color: [.82, .76, .63], box: true });
  const paved = new Set<string>();
  for (const site of townViewSites(config, area)) {
    for (const p of townRoute(map, townSite(map, 'fountain').entrance, site.entrance)) {
      const key = `${p.x},${p.y}`;
      if (paved.has(key)) continue;
      paved.add(key);
      const [x, , z] = townPoint(config, p);
      parts.push({ center: [x, .01, z], radius: [halfCell, .02, halfCell], color: [.73, .68, .54], box: true });
    }
    const owner = world.villagers.find((v) => v.alive && (v.townLife?.homeId === site.id || v.townLife?.formerHomeId === site.id));
    const construction = world.villagers.find((v) => v.alive && v.townLife?.buildHomeId === site.id);
    parts.push(...townBuilding(site, townPoint(config, site.position), halfCell, damagedHomes.has(site.id) || !!construction, owner ? mixedPartsFor(owner) : []));
  }
  for (let i = -17; i <= 17; i += 4) {
    for (const z of [-19, 19]) {
      parts.push({ center: [i, .6, z], radius: [.12, .65, .12], color: [.41, .29, .2], box: true });
      parts.push({ center: [i, 1.6, z], radius: [.65, .95, .65], color: [.26, .43, .31] });
    }
  }
  return parts;
}
