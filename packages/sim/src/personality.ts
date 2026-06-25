// 村人の性格 = 気質6軸。グループ分け (dominant 軸) と行動傾向の土台。

export const PERSONALITY_AXES = [
  'kindness', // 優しさ
  'aggression', // 攻撃性
  'sociability', // 社交性
  'curiosity', // 好奇心
  'discipline', // 規律
  'ambition', // 野心
] as const;

export type PersonalityAxis = (typeof PERSONALITY_AXES)[number];

/** 気質6軸ベクトル。各値は 0..1 を想定 (レーダー/グループ判定)。 */
export type Personality = Record<PersonalityAxis, number>;

export const PERSONALITY_LABELS: Record<PersonalityAxis, string> = {
  kindness: '優しさ',
  aggression: '攻撃性',
  sociability: '社交性',
  curiosity: '好奇心',
  discipline: '規律',
  ambition: '野心',
};

/** 部分指定を既定値 (0) で埋めて完全な性格ベクトルにする。 */
export function makePersonality(partial: Partial<Record<PersonalityAxis, number>> = {}): Personality {
  const out = {} as Personality;
  for (const axis of PERSONALITY_AXES) out[axis] = partial[axis] ?? 0;
  return out;
}

/** 最大値の軸 (同値は PERSONALITY_AXES の並び順で先勝ち)。 */
export function dominantAxis(p: Personality): PersonalityAxis {
  let best: PersonalityAxis = PERSONALITY_AXES[0];
  for (const axis of PERSONALITY_AXES) if (p[axis] > p[best]) best = axis;
  return best;
}

/** dominant 軸でグルーピングする (投票 bloc / 代表選出の単位)。 */
export function groupByDominant<T>(items: T[], getP: (t: T) => Personality): Map<PersonalityAxis, T[]> {
  const groups = new Map<PersonalityAxis, T[]>();
  for (const item of items) {
    const key = dominantAxis(getP(item));
    const arr = groups.get(key);
    if (arr) arr.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
