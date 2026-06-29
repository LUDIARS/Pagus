import type { Villager, VillagerId, GridPos, ActivityPattern, VillagerOrigin, Hobby } from './types/index.js';
import { makePersonality, type PersonalityAxis } from './personality.js';
import { initialWealth, pickHobby } from './economy.js';

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
  /** 出自 (既定 'seed')。出生は 'born'、事件用キャラは 'incident'。 */
  origin?: VillagerOrigin;
  /** 初期所持金 (§15)。未指定なら id ハッシュ + 野心から決定的に算出 (貧富の差)。 */
  wealth?: number;
  /** 趣味嗜好 (§15)。未指定なら dominant 気質から割り当て。 */
  hobby?: Hobby;
}

/** シード or テスト用に、既定値で埋めた どうぶつ を作る。 */
export function createVillager(seed: VillagerSeed): Villager {
  const traits = makePersonality(seed.traits);
  return {
    id: seed.id,
    name: seed.name,
    alive: true,
    persona: {
      traits,
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
    stress: 0,
    partnerId: null,
    origin: seed.origin ?? 'seed',
    eventParams: {},
    wealth: seed.wealth ?? initialWealth(seed.id, traits),
    hobby: seed.hobby ?? pickHobby(traits),
    admireId: null,
    scummy: false,
  };
}
