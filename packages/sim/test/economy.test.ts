import { describe, it, expect } from 'vitest';
import {
  createVillager,
  settleEconomy,
  initialWealth,
  pickHobby,
  wealthTier,
  DEFAULT_ECONOMY,
  makePersonality,
  evaluateRules,
  defaultBehaviorRules,
} from '../src/index.js';
import type { Villager } from '../src/index.js';
import type { EnvironmentView } from '../src/brain.js';

/** 指定値の列を順に返す rng (尽きたら最後の値)。 */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

function villagerWith(id: string, wealth: number, partial: Partial<Villager> = {}): Villager {
  const v = createVillager({ id, name: id, position: { x: 0, y: 0 } });
  v.wealth = wealth;
  return Object.assign(v, partial);
}

describe('住民経済 (§15) — 初期化', () => {
  it('initialWealth は id で散らばり、貧富の差を生む (決定的)', () => {
    const t = makePersonality();
    const w1 = initialWealth('alpha', t);
    const w2 = initialWealth('beta', t);
    expect(w1).toBe(initialWealth('alpha', t)); // 決定的
    expect(w1).not.toBe(w2); // id で散らばる
  });

  it('野心が高いほど初期所持金が増える', () => {
    const poor = initialWealth('x', makePersonality({ ambition: 0 }));
    const rich = initialWealth('x', makePersonality({ ambition: 1 }));
    expect(rich).toBeGreaterThan(poor);
  });

  it('pickHobby は dominant 気質で決まる', () => {
    expect(pickHobby(makePersonality({ ambition: 1 }))).toBe('gourmet');
    expect(pickHobby(makePersonality({ discipline: 1 }))).toBe('ascetic');
    expect(pickHobby(makePersonality({ aggression: 1 }))).toBe('gamble');
  });

  it('wealthTier は閾値で poor/normal/rich を分ける', () => {
    expect(wealthTier(DEFAULT_ECONOMY.poorThreshold - 1)).toBe('poor');
    expect(wealthTier(DEFAULT_ECONOMY.richThreshold)).toBe('rich');
    expect(wealthTier((DEFAULT_ECONOMY.poorThreshold + DEFAULT_ECONOMY.richThreshold) / 2)).toBe('normal');
  });
});

describe('住民経済 (§15) — 日末決済', () => {
  it('収入が入り、趣味に従って消費する', () => {
    const v = villagerWith('a', 100, { hobby: 'ascetic' });
    const before = v.wealth;
    // 送金しない rng (sendChance/demandChance を外す)。
    settleEconomy([v], seqRng([0.99]));
    // 収入(+8〜) - 質素消費(consumeBase*0.4=4) で純増のはず。
    expect(v.wealth).toBeGreaterThan(before);
  });

  it('賭博は質素より荒く消費する', () => {
    const ascetic = villagerWith('a', 100, { hobby: 'ascetic' });
    const gambler = villagerWith('b', 100, { hobby: 'gamble' });
    settleEconomy([ascetic], seqRng([0.99]));
    settleEconomy([gambler], seqRng([0.99]));
    expect(gambler.wealth).toBeLessThan(ascetic.wealth);
  });

  it('推しに送金すると相手の所持金が増える', () => {
    const giver = villagerWith('a', 300, { hobby: 'ascetic', admireId: 'b' });
    const idol = villagerWith('b', 50, { hobby: 'ascetic' });
    // rng: send 判定で 0 (< sendChance) を返して必ず送金。
    const r = settleEconomy([giver, idol], seqRng([0.0, 0.99]));
    expect(r.transfers.length).toBe(1);
    expect(r.transfers[0]?.toId).toBe('b');
    expect(idol.wealth).toBeGreaterThan(50 + DEFAULT_ECONOMY.dailyIncome - 5);
  });

  it('大金を持つとクズ化し、プレイヤーにたかる', () => {
    const v = villagerWith('a', DEFAULT_ECONOMY.scumThreshold + 100, { hobby: 'ascetic', admireId: 'a' });
    // rng: 送金判定 0.99 (送らない) → demand 判定 0.0 (たかる) → demand 額 0.5。
    const r = settleEconomy([v], seqRng([0.99, 0.0, 0.5]));
    expect(v.scummy).toBe(true);
    expect(r.scumChanges.some((c) => c.scummy)).toBe(true);
    expect(r.demands.length).toBe(1);
    expect(r.demands[0]?.villagerId).toBe('a');
  });

  it('退場した推しは選び直される', () => {
    const v = villagerWith('a', 100, { admireId: 'ghost' }); // 存在しない推し
    settleEconomy([v, villagerWith('b', 100)], seqRng([0.99]));
    expect(v.admireId).toBe('b'); // 生存している他者へ
  });
});

describe('住民経済 (§15) — 非行/クズ化の behavior-rule 連動', () => {
  const env: EnvironmentView = { position: { x: 0, y: 0 }, place: '広場', timeOfDay: 'noon', nearby: [] };

  it('貧困個体は wander で事件化しやすい (triggerWeight+)', () => {
    const poor = villagerWith('a', DEFAULT_ECONOMY.poorThreshold - 1);
    const rich = villagerWith('b', 200);
    const rules = defaultBehaviorRules();
    const poorW = evaluateRules(rules, { villager: poor, env, category: 'wander' }).triggerWeight;
    const richW = evaluateRules(rules, { villager: rich, env, category: 'wander' }).triggerWeight;
    expect(poorW).toBeGreaterThan(richW);
  });

  it('大金個体も諍いの火種になりやすい (triggerWeight+)', () => {
    const scum = villagerWith('a', DEFAULT_ECONOMY.scumThreshold + 10);
    const normal = villagerWith('b', 200);
    const rules = defaultBehaviorRules();
    const scumW = evaluateRules(rules, { villager: scum, env, category: 'wander' }).triggerWeight;
    const normalW = evaluateRules(rules, { villager: normal, env, category: 'wander' }).triggerWeight;
    expect(scumW).toBeGreaterThan(normalW);
  });
});
