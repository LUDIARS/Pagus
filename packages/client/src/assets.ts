// どうぶつスプライト (Kenney "Animal pack", CC0)。
// villager.species を pack の動物へ寄せ、無ければ id ハッシュで決定的に割り当てる。

import { Assets, type Texture } from 'pixi.js';
import type { Villager } from '@pagus/sim';

export const ANIMALS = [
  'elephant', 'giraffe', 'hippo', 'monkey', 'panda',
  'parrot', 'penguin', 'pig', 'rabbit', 'snake',
] as const;
export type AnimalName = (typeof ANIMALS)[number];

/** 種 → pack 動物の手寄せ。無い種は id ハッシュにフォールバック。 */
const SPECIES_ANIMAL: Record<string, AnimalName> = {
  兎: 'rabbit',
  梟: 'parrot',
  熊: 'panda',
  猫: 'monkey',
  栗鼠: 'pig',
  鼯鼠: 'penguin',
  蛇: 'snake',
};

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function animalFor(v: Villager): AnimalName {
  return SPECIES_ANIMAL[v.species] ?? ANIMALS[hash(v.id) % ANIMALS.length] ?? 'monkey';
}

/** 全動物テクスチャを読み込んで Map で返す。 */
export async function loadAnimalTextures(): Promise<Map<AnimalName, Texture>> {
  const entries = await Promise.all(
    ANIMALS.map(async (name) => {
      const tex = await Assets.load<Texture>(`/assets/animals/${name}.png`);
      return [name, tex] as const;
    }),
  );
  return new Map(entries);
}
