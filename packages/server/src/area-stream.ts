import { townAreaAt, neighboringTownAreas, MAX_VISIBLE_RESIDENTS, type TownArea, type WireWorld, type ServerMessage } from '@pagus/sim';
import { courtResidents } from './court-frame.js';

/** A complete replacement frame: leaving residents disappear without tombstones. */
export function areaFrame(world: WireWorld, area: TownArea, sequence: number, radius: 1 | 2 = 1): ServerMessage {
  // The cap is a rendering budget, not a story filter: the defendant and the
  // incident's cast must survive it, or a trial plays out with an empty dock.
  const featured = new Set([world.trial?.defendant, world.incident?.perpetrator, ...world.incident?.involved ?? []]
    .filter((id): id is string => typeof id === 'string'));
  const court = area === 'plaza' ? courtResidents(world) : null;
  const neighbors = neighboringTownAreas(area, radius);
  const villagers = court ?? neighbors.flatMap(district => world.villagers.filter((v) => v.alive && (v.hiddenUntilTerm ?? -1) <= world.term
    && townAreaAt(world.config, v.position) === district)
    .sort((a, b) => Number(featured.has(b.id)) - Number(featured.has(a.id)) || a.id.localeCompare(b.id))
    .slice(0, MAX_VISIBLE_RESIDENTS));
  return { t: 'areaFrame', area, radius, sequence, world: {
    ...world, villagers,
    items: world.items.filter((item) => neighbors.includes(townAreaAt(world.config, item.position))),
    residentHistory: [], relationships: [], userFaith: [],
    villagerActionLog: [],
  } };
}
