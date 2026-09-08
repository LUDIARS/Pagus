import type { GridPos, WorldConfig } from './types/index.js';

export const SHOP_NAMES = { doctor: '医者', general: '雑貨屋', carpenter: '大工', tailor: '服屋', grocer: '八百屋', diner: '飯屋', inn: '宿屋' } as const;
export type ShopKind = keyof typeof SHOP_NAMES;
export interface TownSite {
  id: string;
  name: string;
  kind: ShopKind | 'home' | 'fountain' | 'shelter' | 'isolation' | 'hunting';
  position: GridPos;
  entrance: GridPos;
}
export interface TownMap { sites: TownSite[]; width: number; height: number }

/**
 * Smallest grid the plan below still lays out as distinct, reachable sites. The plan is
 * authored on a 23-unit span; compressing it much further collapses separate buildings
 * onto shared cells, and since every site footprint is solid that walls entrances off and
 * makes townRoute return [] — residents would freeze in place with no error at all.
 */
export const MIN_TOWN_GRID = 20;

/** A single, shared town plan. Positions scale with existing saved grid dimensions. */
export function townMap(config: Pick<WorldConfig, 'gridWidth' | 'gridHeight'>): TownMap {
  const width = config.gridWidth, height = config.gridHeight;
  // 設定不備の無言フォールバック禁止 (RULE_CODE §7.1)。
  if (width < MIN_TOWN_GRID || height < MIN_TOWN_GRID) {
    throw new Error(`gridWidth/gridHeight must be at least ${MIN_TOWN_GRID} for the town plan: got ${width}x${height}`);
  }
  const pos = (x: number, y: number): GridPos => ({ x: Math.round(x / 23 * (width - 1)), y: Math.round(y / 23 * (height - 1)) });
  const sites: TownSite[] = [];
  const add = (id: string, name: string, kind: TownSite['kind'], x: number, y: number): void => {
    const position = pos(x, y);
    sites.push({ id, name, kind, position, entrance: { x: position.x, y: Math.min(height - 1, position.y + 1) } });
  };
  add('fountain', '噴水広場', 'fountain', 12, 12);
  // Market frontages flank the civic square, leaving the eight main approaches clear.
  const shops: [ShopKind, number, number][] = [['doctor', 9, 7], ['general', 14, 7], ['carpenter', 17, 10], ['tailor', 7, 10], ['grocer', 17, 14], ['diner', 9, 17], ['inn', 14, 17]];
  for (const [kind, x, y] of shops) add(kind, SHOP_NAMES[kind], kind, x, y);
  for (let i = 0; i < 16; i++) {
    const angle = (i + .5) * Math.PI / 8;
    const radius = i % 2 ? 10.2 : 9.2;
    add(`home-${i}`, `郊外の家 ${i + 1}`, 'home', 11.5 + Math.cos(angle) * radius, 11.5 + Math.sin(angle) * radius);
  }
  add('shelter', '共同の野営地', 'shelter', 1, 19);
  add('isolation', '隔離された離れ', 'isolation', 22, 1);
  add('hunting', '街道の先・狩猟林', 'hunting', 1, 1);
  return { sites, width, height };
}

export function townSite(map: TownMap, id: string): TownSite {
  const site = map.sites.find((s) => s.id === id);
  if (!site) throw new Error(`Unknown town site: ${id}`);
  return site;
}

/** Building footprints and the fountain are solid; entrances remain outdoor destinations. */
export function townBlocked(map: TownMap, p: GridPos): boolean {
  return map.sites.some((s) => s.position.x === p.x && s.position.y === p.y);
}
