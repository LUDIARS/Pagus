import type { World } from './types/index.js';
import { townMap, townSite } from './town-map.js';
import { townRoutine } from './town-routine.js';
import { changeHousing } from './town-residency.js';

/** Four attended carpenter shifts complete one home; progress survives saving. */
export function advanceTownConstruction(world: World): void {
  const residents = [...world.villagers.values()].filter((v) => v.alive);
  const map = townMap(world.config);
  const workshop = townSite(map, 'carpenter').entrance;
  const stamp = `${world.term}:${world.calendar.segment}`;
  for (const worker of residents) {
    const life = worker.townLife;
    if (!life || life.occupation !== 'carpenter' || life.housing === 'isolated'
      || life.lastConstructionTick === stamp || townRoutine(world, worker).activity !== 'work'
      || worker.position.x !== workshop.x || worker.position.y !== workshop.y
      || worker.behaviorTrace?.goal.interrupted) continue;
    const occupied = new Set(residents.flatMap((v) => v.townLife ? [v.townLife.homeId, v.townLife.formerHomeId, v.townLife.buildHomeId] : []));
    const recipient = residents.find((v) => v.townLife?.housing === 'displaced')
      ?? residents.find((v) => v.townLife?.housing === 'unhoused');
    const target = recipient?.townLife;
    if (!target || !recipient) continue;
    const homeId = target.buildHomeId ?? target.formerHomeId ?? map.sites.find((site) => site.kind === 'home' && !occupied.has(site.id))?.id;
    if (!homeId) continue; // Finite land: never overlap an occupied or reserved lot.
    // Only a shift that actually advanced a build is spent; otherwise the carpenter
    // stays eligible for the moment a lot or a waiting resident appears.
    life.lastConstructionTick = stamp;
    target.buildHomeId = homeId;
    target.buildProgress = (target.buildProgress ?? 0) + 1;
    if (target.buildProgress < 4) continue;
    target.formerHomeId = homeId;
    changeHousing(recipient, 'housed', `${worker.name}たち大工が家を建て、入居できるようになった`);
    delete target.buildHomeId;
    delete target.buildProgress;
  }
}
