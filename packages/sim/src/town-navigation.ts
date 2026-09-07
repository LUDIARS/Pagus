import type { GridPos } from './types/index.js';
import { townBlocked, type TownMap } from './town-map.js';

/** Four-way BFS prevents corner cutting. The start may be inside a legacy decoration. */
export function townRoute(map: TownMap, from: GridPos, to: GridPos): GridPos[] {
  const key = (p: GridPos): number => p.y * map.width + p.x;
  const inside = (p: GridPos): boolean => p.x >= 0 && p.y >= 0 && p.x < map.width && p.y < map.height;
  if (!inside(from) || !inside(to)) return [];
  // Learned goals and dropped items can point at a solid footprint. Approach its edge.
  const target = townBlocked(map, to)
    ? [{ x: to.x, y: to.y + 1 }, { x: to.x + 1, y: to.y }, { x: to.x, y: to.y - 1 }, { x: to.x - 1, y: to.y }].find((p) => inside(p) && !townBlocked(map, p))
    : to;
  if (!target) return [];
  const queue: GridPos[] = [from];
  const previous = new Map<number, GridPos | null>([[key(from), null]]);
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    if (key(p) === key(target)) {
      const path: GridPos[] = [];
      let cursor: GridPos = p;
      while (previous.get(key(cursor))) { path.push(cursor); cursor = previous.get(key(cursor))!; }
      return path.reverse();
    }
    for (const next of [{ x: p.x - 1, y: p.y }, { x: p.x + 1, y: p.y }, { x: p.x, y: p.y - 1 }, { x: p.x, y: p.y + 1 }]) {
      if (!inside(next) || townBlocked(map, next) || previous.has(key(next))) continue;
      previous.set(key(next), p);
      queue.push(next);
    }
  }
  return [];
}
