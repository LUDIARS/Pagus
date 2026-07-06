import type { Villager } from './types/index.js';

export const TRIAL_ATTENDEE_LIMIT = 10;

/** 裁判に出廷する住民を、裁判IDを種にして決定的に最大 limit 人まで抽選する。 */
export function pickTrialAttendees(
  villagers: readonly Villager[],
  defendantId: string | null | undefined,
  trialKey: string,
  limit = TRIAL_ATTENDEE_LIMIT,
): Villager[] {
  const alive = villagers.filter((v) => v.alive && v.id !== defendantId);
  if (limit <= 0) return [];
  if (alive.length <= limit) return alive;
  return [...alive]
    .sort((a, b) => {
      const ah = hashString(`${trialKey}:${a.id}`);
      const bh = hashString(`${trialKey}:${b.id}`);
      return ah === bh ? a.id.localeCompare(b.id) : ah - bh;
    })
    .slice(0, limit);
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
