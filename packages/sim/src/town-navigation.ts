import type { GridPos } from './types/index.js';
import { townBlocked, type TownMap } from './town-map.js';
import { townRoadCells } from './town-roads.js';

/** Four-way Dijkstra prefers the stone streets without making off-road goals unreachable. */
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
  const roads = townRoadCells(map);
  const costs = new Map<number, number>([[key(from), 0]]);
  const visited = new Set<number>();
  const previous = new Map<number, GridPos | null>([[key(from), null]]);
  while (queue.length) {
    // Select the cheapest frontier cell in one linear scan. Re-sorting the whole queue on
    // every pop costs O(V² log V) on a grid this routing runs per resident per tick.
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (costs.get(key(queue[i]!))! < costs.get(key(queue[best]!))!) best = i;
    const p = queue[best]!;
    queue[best] = queue[queue.length - 1]!;
    queue.pop();
    if (visited.has(key(p))) continue;
    visited.add(key(p));
    if (key(p) === key(target)) {
      const path: GridPos[] = [];
      let cursor: GridPos = p;
      while (previous.get(key(cursor))) { path.push(cursor); cursor = previous.get(key(cursor))!; }
      return path.reverse();
    }
    for (const next of [{ x: p.x - 1, y: p.y }, { x: p.x + 1, y: p.y }, { x: p.x, y: p.y - 1 }, { x: p.x, y: p.y + 1 }]) {
      if (!inside(next) || townBlocked(map, next) || visited.has(key(next))) continue;
      const cost = costs.get(key(p))! + (roads.has(key(next)) ? 1 : 3);
      if (cost >= (costs.get(key(next)) ?? Infinity)) continue;
      costs.set(key(next), cost);
      previous.set(key(next), p);
      queue.push(next);
    }
  }
  return [];
}
