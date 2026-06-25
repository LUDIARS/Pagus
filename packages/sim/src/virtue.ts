// 村の評判 = 徳目6軸。世界側 LLM の日末評価で動くレーダー。
// 村人の性格 (気質6軸) とは 1:1 で対応する。

import { PERSONALITY_AXES, type PersonalityAxis, type Personality } from './personality.js';

export const VIRTUES = [
  'benevolence', // 善良
  'malice', // 悪辣
  'order', // 秩序
  'vitality', // 活気
  'intellect', // 知性
  'faith', // 信仰
] as const;

export type Virtue = (typeof VIRTUES)[number];

/** 徳目6軸ベクトル (村の評判)。各値は 0..1 を想定。 */
export type VirtueVector = Record<Virtue, number>;

export const VIRTUE_LABELS: Record<Virtue, string> = {
  benevolence: '善良',
  malice: '悪辣',
  order: '秩序',
  vitality: '活気',
  intellect: '知性',
  faith: '信仰',
};

/** 気質6軸 → 徳目6軸 の 1:1 対応。 */
export const VIRTUE_OF_AXIS: Record<PersonalityAxis, Virtue> = {
  kindness: 'benevolence',
  aggression: 'malice',
  sociability: 'vitality',
  curiosity: 'intellect',
  discipline: 'order',
  ambition: 'faith',
};

export function makeVirtueVector(partial: Partial<Record<Virtue, number>> = {}): VirtueVector {
  const out = {} as VirtueVector;
  for (const v of VIRTUES) out[v] = partial[v] ?? 0;
  return out;
}

/** 性格ベクトルを 1:1 対応で徳目ベクトルへ写す (出生バイアス等に使う)。 */
export function virtueFromPersonality(p: Personality): VirtueVector {
  const out = makeVirtueVector();
  for (const axis of PERSONALITY_AXES) out[VIRTUE_OF_AXIS[axis]] = p[axis];
  return out;
}
