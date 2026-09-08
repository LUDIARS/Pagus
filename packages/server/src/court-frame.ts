import { townMap, townSite, FACTION_SIDE_LIMIT, MAX_VISIBLE_RESIDENTS, type WireWorld } from '@pagus/sim';

/**
 * 左右の着席上限は勢力定員 (§ 勢力裁判) に揃える。ただし両側ぶんが描画予算を超えないよう、
 * 予算の半分で頭打ちにする。定員を増やしてもクライアントの描画上限は破らない。
 */
const COURT_SEATS_PER_SIDE = Math.min(FACTION_SIDE_LIMIT, Math.floor(MAX_VISIBLE_RESIDENTS / 2));

/** Server-authored stage positions. Daily-world positions are never overwritten. */
export function courtResidents(world: WireWorld): WireWorld['villagers'] | null {
  const f = world.trial?.factions;
  if (!f || !['ten', 'ketsu', 'reform'].includes(world.phase)) return null;
  const centre = townSite(townMap(world.config), 'fountain').entrance;
  return (['accusers', 'defenders'] as const).flatMap((side, sideIndex) => f[side].slice(0, COURT_SEATS_PER_SIDE).flatMap((id, index) => {
    const v = world.villagers.find(actor => actor.id === id);
    if (!v?.alive || (v.hiddenUntilTerm ?? -1) > world.term) return [];
    const { behaviorTrace: _trace, ...resident } = v;
    return [{ ...resident, position: {
      x: centre.x + (sideIndex === 0 ? -1 : 1) * (1.2 + (index % 2) * .7),
      y: centre.y + Math.floor(index / 2) * .6,
    } }];
  }));
}
