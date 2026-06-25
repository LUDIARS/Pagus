import type { Villager, VillagerId, GridPos } from './types/index.js';

export interface VillagerSeed {
  id: VillagerId;
  name: string;
  position: GridPos;
  traits?: Record<string, number>;
  values?: string[];
  speechStyle?: string;
  body?: string;
}

/** シード or テスト用に、既定値で埋めた村人を作る。 */
export function createVillager(seed: VillagerSeed): Villager {
  return {
    id: seed.id,
    name: seed.name,
    alive: true,
    persona: {
      traits: seed.traits ?? {},
      values: seed.values ?? [],
      speechStyle: seed.speechStyle ?? 'ふつう',
    },
    emotion: { axes: {}, label: 'ふつう' },
    information: [],
    position: { ...seed.position },
    appearance: { body: seed.body ?? 'human', descriptors: [] },
    reformCount: 0,
  };
}
