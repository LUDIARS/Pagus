import type { Villager, VillagerId, GridPos, ActivityPattern } from './types/index.js';
import { makePersonality, type PersonalityAxis } from './personality.js';

export interface VillagerSeed {
  id: VillagerId;
  name: string;
  position: GridPos;
  species?: string;
  activity?: ActivityPattern;
  traits?: Partial<Record<PersonalityAxis, number>>;
  values?: string[];
  speechStyle?: string;
  body?: string;
  madman?: boolean;
}

/** シード or テスト用に、既定値で埋めた どうぶつ を作る。 */
export function createVillager(seed: VillagerSeed): Villager {
  return {
    id: seed.id,
    name: seed.name,
    alive: true,
    persona: {
      traits: makePersonality(seed.traits),
      values: seed.values ?? [],
      speechStyle: seed.speechStyle ?? 'ふつう',
    },
    emotion: { axes: {}, label: 'ふつう' },
    information: [],
    position: { ...seed.position },
    appearance: { body: seed.body ?? 'human', descriptors: [] },
    species: seed.species ?? '猫',
    activity: seed.activity ?? 'diurnal',
    reformCount: 0,
    madman: seed.madman ?? false,
  };
}
