// 小騒動 (minor incident, §v1.4-B) — 月次大事件の谷を埋める LLM 0 円の山。
// organic の事件化のうち一部を「裁判に至らない寸劇」として即時決着させ、
// 収まるか、遺恨 (rumor 火種) を残すかに分岐する。フェーズは変えない。

import type { Villager } from './types/index.js';

/** 小騒動のチューニング値 (config arc.*)。 */
export interface MinorConfig {
  /** organic の事件化を小騒動に流す確率。 */
  minorChance: number;
  /** 小騒動が火種 (rumor) を残す確率。 */
  minorResidueChance: number;
}

export const DEFAULT_MINOR: MinorConfig = {
  minorChance: 0.25,
  minorResidueChance: 0.5,
};

/** 寸劇テンプレ (開幕 → 応酬)。{a}/{b} を差し込む。 */
const OPENINGS = [
  '{a} と {b} が口論になった',
  '{a} が {b} に肩をぶつけた',
  '{a} が {b} の持ち物にけちをつけた',
  '{a} が {b} の噂話を本人の前でしてしまった',
];
const RETORTS = [
  '{b} が言い返して場が凍りついた',
  '{b} は鼻を鳴らしてそっぽを向いた',
  '{b} が声を荒げ、周りがざわついた',
];
const CALM_ENDINGS = ['周りがなだめて事は収まった', '{a} が折れて、その場は笑いに変わった'];
const RESIDUE_ENDINGS = ['{b} は根に持った…', '{a} と {b} の間に冷たい空気が残った'];

export interface MinorIncidentResult {
  /** 寸劇の行 (live feed 表示用、2〜3 行)。 */
  lines: string[];
  /** 遺恨が残ったか (呼び出し側が rumor 火種を立てる)。 */
  residue: boolean;
}

function fill(template: string, a: string, b: string): string {
  return template.replaceAll('{a}', a).replaceAll('{b}', b);
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  const v = arr[Math.floor(rng() * arr.length)] ?? arr[0];
  if (v === undefined) throw new Error('minor-incident: 空のテンプレ配列');
  return v;
}

/**
 * 小騒動を演じる (§v1.4-B)。actor と victim の 2〜3 行の寸劇を返し、
 * 双方の感情を軽く揺らす (怒り +0.08)。residue=true なら遺恨が残った
 * (呼び出し側で rumor 火種を立て、火種の加熱にも使う)。
 */
export function playMinorIncident(
  actor: Villager,
  victim: Villager,
  rng: () => number,
  cfg: MinorConfig = DEFAULT_MINOR,
): MinorIncidentResult {
  const a = actor.name;
  const b = victim.name;
  const residue = rng() < cfg.minorResidueChance;
  const lines = [
    `〽 小騒動: ${fill(pick(OPENINGS, rng), a, b)}`,
    fill(pick(RETORTS, rng), a, b),
    fill(pick(residue ? RESIDUE_ENDINGS : CALM_ENDINGS, rng), a, b),
  ];
  for (const v of [actor, victim]) {
    const anger = (v.emotion.axes['anger'] ?? 0) + 0.08;
    v.emotion.axes['anger'] = Math.min(1, Math.max(-1, anger));
  }
  return { lines, residue };
}
