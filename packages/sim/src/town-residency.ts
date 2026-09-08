import type { Villager, World } from './types/index.js';
import { SHOP_NAMES, townMap, type ShopKind } from './town-map.js';

export type HousingStatus = 'housed' | 'unhoused' | 'displaced' | 'isolated';
export const HOUSING_NAMES: Record<HousingStatus, string> = { housed: '家がある', unhoused: '家を持たない', displaced: '家を失った', isolated: '迫害により隔離されている' };
export interface TownLife {
  buildHomeId?: string;
  buildProgress?: number;
  lastConstructionTick?: string;
  housing: HousingStatus;
  homeId: string;
  formerHomeId?: string;
  isolationReturnHousing?: Exclude<HousingStatus, 'isolated'>;
  reason: string;
  occupation: ShopKind | 'hunter';
}

/** Assign once, including immigrants and old snapshots; education never rerolls a life. */
export function ensureTownResidents(world: World): void {
  const residents = [...world.villagers.values()].filter((v) => v.alive);
  const firstSettlement = residents.length >= 8 && residents.every((v) => !v.townLife);
  const homes = townMap(world.config).sites.filter((s) => s.kind === 'home');
  const occupied = new Set(residents.flatMap((v) => v.townLife ? [v.townLife.homeId, v.townLife.formerHomeId, v.townLife.buildHomeId] : []));
  const jobs: TownLife['occupation'][] = [...Object.keys(SHOP_NAMES) as ShopKind[], 'hunter'];
  for (const v of world.villagers.values()) {
    if (v.townLife || !v.alive) continue;
    const counts = jobs.map((job) => [...world.villagers.values()].filter((r) => r.alive && r.townLife?.occupation === job).length);
    const occupation = jobs[counts.indexOf(Math.min(...counts))]!;
    // Only the opening settlement starts with built houses. Later arrivals queue
    // for carpenter construction instead of materializing an instant home.
    const home = firstSettlement ? homes.find((s) => !occupied.has(s.id)) : undefined;
    v.townLife = { housing: home ? 'housed' : 'unhoused', homeId: home?.id ?? 'shelter', reason: home ? '街に定住したときに割り当てられた家' : '大工による家の建設を待ち、野営地を寝床にしている', occupation };
    if (home) occupied.add(home.id);
  }
  // Opening cast backstories are authored at first town setup, never inferred from
  // species, wealth, or mixed appearance, and never repeated for later immigrants.
  if (firstSettlement) {
    const [unhoused, displaced] = residents.filter((v) => v.townLife?.occupation !== 'hunter').slice(-2);
    if (unhoused?.townLife) {
      unhoused.townLife.homeId = 'shelter';
      changeHousing(unhoused, 'unhoused', '定住する家を持たず、共同の野営地で寝起きしている');
    }
    if (displaced) changeHousing(displaced, 'displaced', '以前の火災で家を失い、再建を待って野営地に身を寄せている');
  }
}

/** Explicit story consequences, independent of species or education appearance. */
export function changeHousing(v: Villager, housing: HousingStatus, reason: string): void {
  const life = v.townLife;
  if (!life) throw new Error('Town residency must be assigned before changing housing');
  if (!reason.trim()) throw new Error('Housing changes require a story reason');
  if (housing === 'isolated' && life.housing !== 'isolated') {
    life.isolationReturnHousing = life.housing;
  }
  if (housing === 'housed') {
    const home = life.formerHomeId ?? (life.homeId.startsWith('home-') ? life.homeId : undefined);
    if (!home) throw new Error('A home must be assigned before rehousing');
    life.homeId = home;
    delete life.formerHomeId;
  } else {
    if (life.homeId.startsWith('home-')) life.formerHomeId = life.homeId;
    life.homeId = housing === 'isolated' ? 'isolation' : 'shelter';
  }
  life.housing = housing;
  if (housing !== 'isolated') delete life.isolationReturnHousing;
  life.reason = reason;
  delete v.behaviorTrace;
}
