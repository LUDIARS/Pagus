import { townAreaAt, MAX_VISIBLE_RESIDENTS, type TownArea, type WireWorld, type ServerMessage } from '@pagus/sim';

/** A complete replacement frame: leaving residents disappear without tombstones. */
export function areaFrame(world: WireWorld, area: TownArea, sequence: number): ServerMessage {
  // The cap is a rendering budget, not a story filter: the defendant and the
  // incident's cast must survive it, or a trial plays out with an empty dock.
  const featured = new Set([world.trial?.defendant, world.incident?.perpetrator, ...world.incident?.involved ?? []]
    .filter((id): id is string => typeof id === 'string'));
  const villagers = world.villagers.filter((v) => v.alive && (v.hiddenUntilTerm ?? -1) <= world.term
    && townAreaAt(world.config, v.position) === area)
    .sort((a, b) => Number(featured.has(b.id)) - Number(featured.has(a.id)) || a.id.localeCompare(b.id))
    .slice(0, MAX_VISIBLE_RESIDENTS);
  return { t: 'areaFrame', area, sequence, world: {
    ...world, villagers,
    items: world.items.filter((item) => townAreaAt(world.config, item.position) === area),
    residentHistory: [], relationships: [], userFaith: [],
    villagerActionLog: [],
  } };
}
