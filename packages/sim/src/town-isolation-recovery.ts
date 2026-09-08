import type { Villager, World } from './types/index.js';
import { changeHousing, type HousingStatus } from './town-residency.js';

const RETURN_REASONS: Record<Exclude<HousingStatus, 'isolated'>, string> = {
  housed: '平穏な日々を過ごし、隔離先から自宅と仕事に戻った',
  displaced: '平穏な日々を過ごし、街の仕事に戻って大工による住まいの再建を待っている',
  unhoused: '平穏な日々を過ごし、街の仕事に戻って大工による家の建設を待っている',
};

export const ISOLATION_PEACE_DAYS = 3;
const HARASSMENT_THRESHOLD = 6;
const PRESSURE = 'townHarassment';
const LAST_HARASSMENT = 'townLastHarassmentTick';

/** Simulation time only: reconnects and repeated ticks never advance recovery. */
function townTick(world: World): number {
  return world.term * world.config.segmentsPerDay + world.calendar.segment;
}

/** Recent harassment restarts the resident's uninterrupted peace interval. */
export function recordTownHarassment(world: World, target: Villager): void {
  const now = townTick(world);
  const last = target.eventParams[LAST_HARASSMENT];
  if (last !== undefined && now - last >= ISOLATION_PEACE_DAYS * world.config.segmentsPerDay) {
    delete target.eventParams[PRESSURE];
  }
  target.eventParams[LAST_HARASSMENT] = now;
  target.eventParams[PRESSURE] = (target.eventParams[PRESSURE] ?? 0) + 1;
  if (target.eventParams[PRESSURE] >= HARASSMENT_THRESHOLD && target.townLife && target.townLife.housing !== 'isolated') {
    changeHousing(target, 'isolated', '繰り返される嫌がらせから逃れ、街はずれの離れで暮らしている');
  }
}

/** Restore daily life after three peaceful days, including residents in old saves. */
export function advanceTownIsolationRecovery(world: World): void {
  const now = townTick(world);
  const peaceTicks = ISOLATION_PEACE_DAYS * world.config.segmentsPerDay;
  for (const resident of world.villagers.values()) {
    const life = resident.townLife;
    if (!resident.alive || !life || (life.housing !== 'isolated' && (resident.eventParams[PRESSURE] ?? 0) <= 0)) continue;
    const last = resident.eventParams[LAST_HARASSMENT];
    // Old saves have no timestamp. Start a real waiting interval; do not infer peace
    // from process downtime or immediately rewrite the whole town on load.
    if (last === undefined || last > now) {
      resident.eventParams[LAST_HARASSMENT] = now;
      continue;
    }
    if (now - last < peaceTicks) continue;
    delete resident.eventParams[PRESSURE];
    delete resident.eventParams[LAST_HARASSMENT];
    if (life.housing !== 'isolated') continue;
    // Legacy saves cannot distinguish an intact former home from a lost one.
    // Keep the lot reserved and let carpenters restore it instead of inventing a house.
    const saved = life.isolationReturnHousing ?? (life.formerHomeId ? 'displaced' : 'unhoused');
    // Rehousing needs a real lot. A resident isolated while nominally housed but
    // camped in the shelter has none, so send them back to the build queue.
    const housing = saved === 'housed' && !life.formerHomeId ? 'unhoused' : saved;
    changeHousing(resident, housing, RETURN_REASONS[housing]);
  }
}
