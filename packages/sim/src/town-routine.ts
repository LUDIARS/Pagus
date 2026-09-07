import type { Calendar, Villager, WorldConfig } from './types/index.js';
import { isAwake } from './calendar.js';
import { SHOP_NAMES, townMap, townSite } from './town-map.js';
import type { ResidentGoal } from './resident-goals.js';

export interface RoutineContext { config: WorldConfig; calendar: Calendar }
export interface TownRoutine { activity: 'rest' | 'meal' | 'work' | 'social'; siteId: string; label: string }

/** Activity-relative shifts preserve nocturnal and crepuscular residents' rhythms. */
export function townRoutine(context: RoutineContext, v: Villager): TownRoutine {
  const life = v.townLife;
  if (!life) return { activity: 'social', siteId: 'fountain', label: '広場で住まいと仕事の案内を待つ' };
  const n = context.config.segmentsPerDay;
  const segment = context.calendar.segment;
  const home = life.homeId;
  if (!isAwake(v.activity, segment, n)) return { activity: 'rest', siteId: home, label: '寝床に戻って休む' };
  if (life.housing === 'isolated') return { activity: 'work', siteId: home, label: `${SHOP_NAMES[life.occupation as keyof typeof SHOP_NAMES] ?? '狩猟'}の内職・道具の手入れ（隔離生活）` };
  // Count consecutive waking slots back to waking, including shifts crossing midnight.
  let elapsed = 0;
  while (elapsed < n - 1 && isAwake(v.activity, (segment - elapsed - 1 + n) % n, n)) elapsed++;
  let remaining = 0;
  while (remaining < n - 1 && isAwake(v.activity, (segment + remaining + 1) % n, n)) remaining++;
  if (v.activity === 'always') { elapsed = segment; remaining = n - segment - 1; }
  if (remaining === 0 && elapsed > 0) return { activity: 'rest', siteId: home, label: '仕事を終え、寝床へ帰る' };
  // Short waking windows are a work shift; meals are implied before/after it.
  if (elapsed + remaining > 2 && elapsed === 0) return { activity: 'meal', siteId: 'diner', label: '飯屋で食事をとる' };
  if (remaining === 1 && elapsed > 1) return { activity: 'social', siteId: 'fountain', label: '噴水広場で仕事帰りの住民と過ごす' };
  return life.occupation === 'hunter'
    ? { activity: 'work', siteId: 'hunting', label: '街道を抜け、街の外の森で狩猟する' }
    : { activity: 'work', siteId: life.occupation, label: `${SHOP_NAMES[life.occupation]}で働く` };
}

export function routineGoal(context: RoutineContext, v: Villager): ResidentGoal {
  const routine = townRoutine(context, v);
  const site = townSite(townMap(context.config), routine.siteId);
  return { kind: routine.activity === 'meal' ? 'social' : routine.activity, label: routine.label, destination: { ...site.entrance }, priority: routine.activity === 'rest' ? 85 : 50, interrupted: false };
}

export function routineSchedule(context: RoutineContext, v: Villager): string[] {
  return Array.from({ length: context.config.segmentsPerDay }, (_, segment) => {
    const routine = townRoutine({ ...context, calendar: { ...context.calendar, segment } }, v);
    return `${String(Math.floor(segment / context.config.segmentsPerDay * 24)).padStart(2, '0')}:00 ${routine.label}`;
  });
}
