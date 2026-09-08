import type { Villager, World } from './types/index.js';
import type { ResidentGoal } from './resident-goals.js';
import { isAwake } from './calendar.js';
import { townMap, townBlocked } from './town-map.js';
import { townRoadCells } from './town-roads.js';
import { townRoutine } from './town-routine.js';

/** Stable for one segment: free-time visits alternate with short walks along the streets. */
export function socialGoal(world: World, v: Villager, routine: ResidentGoal): ResidentGoal {
  if (routine.kind !== 'social' || townRoutine(world, v).activity !== 'social') return routine;
  const seed = [...v.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  const slot = world.term * world.config.segmentsPerDay + world.calendar.segment + seed;
  const nearby = [...world.villagers.values()].filter(n => n.id !== v.id && n.alive
    && (n.hiddenUntilTerm ?? -1) <= world.term && n.townLife?.housing !== 'isolated'
    && isAwake(n.activity, world.calendar.segment, world.config.segmentsPerDay)
    && Math.hypot(n.position.x - v.position.x, n.position.y - v.position.y) <= 6)
    .sort((a, b) => a.id.localeCompare(b.id));
  const target = nearby[slot % Math.max(1, nearby.length)];
  if (target && slot % 3 !== 0) return { ...routine, destination: { ...target.position },
    label: `${target.name}に話しかけに行く` };
  const map = townMap(world.config);
  const streets = [...townRoadCells(map)].map(key => ({ x: key % map.width, y: Math.floor(key / map.width) }))
    .filter(p => !townBlocked(map, p) && Math.hypot(p.x - routine.destination.x, p.y - routine.destination.y) <= 5);
  const destination = streets[slot % Math.max(1, streets.length)];
  return destination ? { ...routine, destination, label: '石畳の街路を散歩する' } : routine;
}
