// 村のしきたり (§8.1)。事件の火種になる「適当に用意されるルール」。
// テンプレ集からランダムに重複なく抽選する。LLM を使わない (既定=テンプレ)。

import type { VillageRule } from './types/index.js';

/** 村のしきたりテンプレ集 (事件の火種)。新規村に何件か入れる。 */
export const DEFAULT_RULE_TEMPLATES: string[] = [
  '夜に口笛を吹いてはならない',
  '梟は井戸に近づいてはならない',
  '満月の夜は誰も家の外に出てはならない',
  '広場の古井戸を覗き込んではならない',
  '祭りの日に赤い実を食べてはならない',
  '客人に本当の名前を教えてはならない',
  '雨の日は鏡を見てはならない',
  '村はずれの木に登ってはならない',
  '日暮れ後によその家の戸を叩いてはならない',
  '双子は同じ服を着てはならない',
];

/**
 * テンプレから重複なく n 件抽選して VillageRule[] を作る。
 * rng は [0,1) を返す乱数 (例 Math.random)。id は rule_1.. で採番する。
 */
export function pickVillageRules(rng: () => number, n: number): VillageRule[] {
  const pool = [...DEFAULT_RULE_TEMPLATES];
  const count = Math.min(Math.max(0, Math.floor(n)), pool.length);
  const out: VillageRule[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    const [text] = pool.splice(idx, 1);
    if (text === undefined) break; // 念のため (無言フォールバックではなく安全打ち切り)
    out.push({ id: `rule_${i + 1}`, text });
  }
  return out;
}
