import { townAreaAt, type TownArea, type WireWorld, type ServerMessage } from '@pagus/sim';

/** A complete replacement frame: leaving residents disappear without tombstones. */
export function areaFrame(world: WireWorld, area: TownArea, sequence: number): ServerMessage {
  const villagers = world.villagers.filter((v) => v.alive && (v.hiddenUntilTerm ?? -1) <= world.term
    && townAreaAt(world.config, v.position) === area);
  return { t: 'areaFrame', area, sequence, world: {
    ...world, villagers,
    items: world.items.filter((item) => townAreaAt(world.config, item.position) === area),
    residentHistory: [], relationships: [], userFaith: [],
    villagerActionLog: [],
  } };
}
