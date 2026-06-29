import { describe, it, expect } from 'vitest';
import {
  createVillager,
  createWorld,
  popularity,
  computeMayorPoll,
  electMayor,
  tickMayor,
  recallMayor,
  recallProbability,
  DEFAULT_MAYOR,
  makePersonality,
  REACTION_EXPOSURE,
} from '../src/index.js';
import type { Villager, World, MayorConfig, PersonalityAxis } from '../src/index.js';

function mk(id: string, traits: Partial<Record<PersonalityAxis, number>>, emotion: Record<string, number> = {}): Villager {
  const v = createVillager({ id, name: id, position: { x: 0, y: 0 }, traits });
  v.emotion = { axes: emotion, label: 'ふつう' };
  return v;
}
/** 支持層 (どのバケツにも落ちない) になりやすい無難な村人。 */
function plain(id: string, kindness = 0.5): Villager {
  return mk(id, { kindness, sociability: 0.6, curiosity: 0.3, discipline: 0.6 });
}
function worldOf(vs: Villager[]): World {
  const w = createWorld(vs);
  w.mayorId = null; // createWorld 既定。TermMachine 非経由なので明示。
  return w;
}
const SMALL: MayorConfig = { ...DEFAULT_MAYOR, electionIntervalTerms: 10, campaignTerms: 6, pollRefreshTerms: 3 };

describe('村長選挙 (§17) — 人気度', () => {
  it('優しく社交的な村人は攻撃的・狂人より人気が高い', () => {
    const kind = mk('k', { kindness: 1, sociability: 0.8 });
    const aggro = mk('a', { aggression: 1 });
    const mad = createVillager({ id: 'm', name: 'm', position: { x: 0, y: 0 }, traits: { kindness: 1 }, madman: true });
    expect(popularity(kind)).toBeGreaterThan(popularity(aggro));
    expect(popularity(mad)).toBeLessThan(popularity(kind));
  });
});

describe('村長選挙 (§17) — electMayor', () => {
  it('人気度最大の村人が村長になり、任期がセットされる', () => {
    const w = worldOf([plain('lo', 0.2), plain('hi', 0.9)]);
    const name = electMayor(w, SMALL);
    expect(name).toBe('hi');
    expect(w.mayorId).toBe('hi');
    expect(w.mayorTermsLeft).toBe(SMALL.electionIntervalTerms);
  });

  it('除外 id は当選しない', () => {
    const w = worldOf([plain('a', 0.9), plain('b', 0.5)]);
    expect(electMayor(w, SMALL, 'a')).toBe('b');
  });
});

describe('村長選挙 (§17) — 世論調査', () => {
  it('攻撃的+怒りはみんなきらい、無関心はきょうみない、低規律はわからない', () => {
    const hater = mk('h', { aggression: 0.8 }, { anger: 0.5 }); // 1.3 > 1.1
    const apathetic = mk('a', { sociability: 0.1, curiosity: 0.1 }); // 0.2 < 0.6
    const unsure = mk('u', { sociability: 0.5, curiosity: 0.5, discipline: 0.1 }); // 規律 0.1 < 0.35
    const supporter = plain('s', 0.7);
    const w = worldOf([hater, apathetic, unsure, supporter]);
    electMayor(w, SMALL);
    const poll = computeMayorPoll(w, SMALL);
    expect(poll.hate).toBeCloseTo(0.25, 6);
    expect(poll.noInterest).toBeCloseTo(0.25, 6);
    expect(poll.dontKnow).toBeCloseTo(0.25, 6);
    expect(poll.candidates.length).toBeGreaterThan(0);
    expect(poll.approval).toBeGreaterThan(0);
  });
});

describe('村長選挙 (§17) — tickMayor', () => {
  it('任期 0 で通常選挙、期間中は世論調査を更新する', () => {
    const w = worldOf([plain('a', 0.9), plain('b', 0.4)]);
    electMayor(w, SMALL); // termsLeft = 10
    // 6 まで減らす (campaign 突入直前)。
    for (let i = 0; i < 4; i++) tickMayor(w, SMALL); // 10→6
    expect(w.mayorTermsLeft).toBe(6);
    // campaign 中: pollRefreshTerms(3) ごとに poll 更新。sinceStart=0 で更新済のはず。
    expect(w.mayorPoll).not.toBeNull();
    // 残りを 0 まで → 選挙。
    let elected = null;
    for (let i = 0; i < 6; i++) elected = tickMayor(w, SMALL) ?? elected;
    expect(elected?.kind).toBe('elected');
    expect(w.mayorTermsLeft).toBe(SMALL.electionIntervalTerms);
  });

  it('村長が退場すると補欠選挙が起きる', () => {
    const a = plain('a', 0.9);
    const b = plain('b', 0.4);
    const w = worldOf([a, b]);
    electMayor(w, SMALL);
    expect(w.mayorId).toBe('a');
    a.alive = false; // 村長が死亡
    const ev = tickMayor(w, SMALL);
    expect(ev?.kind).toBe('vacancy-elected');
    expect(w.mayorId).toBe('b');
  });
});

describe('村長選挙 (§17) — リコール', () => {
  it('成功確率は支持率が低く過去の事件が多いほど上がる', () => {
    const good = plain('good', 0.9);
    const w1 = worldOf([good, plain('x', 0.5)]);
    electMayor(w1, SMALL);
    const pGood = recallProbability(w1, SMALL);

    const bad = plain('bad', 0.9);
    bad.reformCount = 3;
    bad.eventParams[REACTION_EXPOSURE] = 3;
    const w2 = worldOf([bad, plain('y', 0.5)]);
    electMayor(w2, SMALL);
    const pBad = recallProbability(w2, SMALL);
    expect(pBad).toBeGreaterThan(pGood);
  });

  it('rng < 成功率 で罷免され、罷免者を除いて補欠当選する', () => {
    const m = plain('m', 0.9);
    m.reformCount = 5;
    const w = worldOf([m, plain('n', 0.5)]);
    electMayor(w, SMALL);
    const r = recallMayor(w, () => 0, SMALL); // rng=0 → 必ず成立
    expect(r.attempted).toBe(true);
    expect(r.success).toBe(true);
    expect(r.ousted).toBe('m');
    expect(w.mayorId).toBe('n'); // 罷免者を除いて補欠
  });

  it('rng >= 成功率 なら不成立 (村長は留任)', () => {
    const w = worldOf([plain('m', 0.9), plain('n', 0.5)]);
    electMayor(w, SMALL);
    const r = recallMayor(w, () => 1, SMALL); // rng=1 → 不成立
    expect(r.success).toBe(false);
    expect(w.mayorId).toBe('m');
  });
});
