import type { GridPos } from './types/index.js';
import type { TownMap } from './town-map.js';

const cache = new Map<string, ReadonlySet<number>>();
/** Road-first plan: eight spokes, a ring and short frontage lanes, shared by navigation and rendering. */
export function townRoadCells(map: TownMap): ReadonlySet<number> {
  const signature = `${map.width}:${map.height}:${map.sites.map(s => `${s.position.x},${s.position.y}`).join(';')}`;
  const existing = cache.get(signature);
  if (existing) return existing;
  const center = map.sites.find(s => s.kind === 'fountain')!.position;
  const radius = Math.min(map.width, map.height) * .34;
  const segments: [GridPos, GridPos][] = [];
  const ring: GridPos[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4;
    const end = { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
    ring.push(end);
    segments.push([center, { x: center.x + Math.cos(angle) * radius * 1.5, y: center.y + Math.sin(angle) * radius * 1.5 }]);
  }
  for (let i = 0; i < ring.length; i++) segments.push([ring[i]!, ring[(i + 1) % ring.length]!]);
  const main = [...segments];
  for (const site of map.sites) {
    const nearest = main.map(([a, b]) => nearestPoint(site.entrance, a, b))
      .sort((a, b) => Math.hypot(a.x - site.entrance.x, a.y - site.entrance.y) - Math.hypot(b.x - site.entrance.x, b.y - site.entrance.y))[0]!;
    segments.push([site.entrance, nearest]);
  }
  const solid = new Set(map.sites.map(s => s.position.y * map.width + s.position.x));
  const paved = new Set<number>();
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const key = y * map.width + x;
    if (solid.has(key)) continue;
    if (Math.hypot(x - center.x, y - center.y) <= 2 || segments.some(([a, b]) => {
      const p = nearestPoint({ x, y }, a, b);
      return Math.hypot(p.x - x, p.y - y) <= .72;
    })) paved.add(key);
  }
  cache.set(signature, paved);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return paved;
}

function nearestPoint(p: GridPos, a: GridPos, b: GridPos): GridPos {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return { x: a.x + t * dx, y: a.y + t * dy };
}
