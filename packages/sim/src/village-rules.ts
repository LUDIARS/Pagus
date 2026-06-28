// 村のしきたり (§8.1)。事件の火種になる「適当に用意されるルール」。
// テンプレ集からランダムに重複なく抽選する。LLM を使わない (既定=テンプレ)。

import type { World, VillageRule } from './types/index.js';

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

/**
 * 既存の村ルール id から末尾の数値を拾い、最大+1 を返す (なければ 1)。
 * snapshot 復元後でも id が衝突しないよう、module-level カウンタでなく
 * 現在の world.villageRules から決定的に採番する (§2 しきたり改定)。
 */
function nextRuleSeq(world: World): number {
  let max = 0;
  for (const r of world.villageRules) {
    const m = /(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * 村ルールを 1 件追加する (§2)。id は既存 (`rule_N`) と衝突しない `vrule_<n>` で採番。
 * maxRules を渡し、既に上限なら追加せず null を返す (無言フォールバックでなく明示的不成立)。
 * text の trim/長さ検証は呼び側 (server) の責務。
 */
export function addVillageRule(world: World, text: string, maxRules?: number): VillageRule | null {
  if (maxRules !== undefined && world.villageRules.length >= maxRules) return null;
  const rule: VillageRule = { id: `vrule_${nextRuleSeq(world)}`, text };
  world.villageRules.push(rule);
  return rule;
}

/** 村ルールを id で削除する (§2)。消せたら true、該当が無ければ false。 */
export function removeVillageRule(world: World, ruleId: string): boolean {
  const idx = world.villageRules.findIndex((r) => r.id === ruleId);
  if (idx < 0) return false;
  world.villageRules.splice(idx, 1);
  return true;
}
