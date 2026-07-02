// 蒸留の採否ゲート (rule-replay, §v1.4-C)。
// 記録済みの乖離ケース (教師 LLM と 生徒=DailyEngine の食い違い) に対して、
// 新ルールを含むルール集合を決定的に再評価し、教師との一致率が改善するときだけ採用する。
// LLM 非依存の純関数 — 蒸留ルールの品質を「もっともらしさ」でなく再現性で測る。

import type { Villager, EmotionState, TimeOfDay } from './types/index.js';
import type { EnvironmentView } from './brain.js';
import { evaluateRules, type BehaviorRule, type RuleCategory } from './behavior-rules.js';
import { PERSONALITY_AXES, type Personality } from './personality.js';

/**
 * 乖離ケース 1 件。shadow sampling (server) が記録する。
 * 再評価に必要な最小限の住民/環境スナップショットを持つ (Villager 丸ごとは持たない)。
 */
export interface DivergenceCase {
  /** 記録したターム。 */
  term: number;
  villager: {
    id: string;
    species: string;
    traits: Record<string, number>;
    emotionAxes: Record<string, number>;
    eventParams: Record<string, number>;
    wealth: number;
    stress: number;
    /** 持っていた情報の本文 (infoContains/infoFromPlayer 条件の再評価用)。 */
    infoTexts: string[];
    infoFromPlayer: boolean;
  };
  env: {
    place: string;
    timeOfDay: TimeOfDay;
    hasNeighbor: boolean;
    placeState?: 'defiled' | 'blessed';
  };
  category: RuleCategory;
  /** 教師 (LLM) の判断。 */
  teacher: {
    /** 教師が返した感情の変化量 (軸ごと)。 */
    emotionDelta: Record<string, number>;
    triggersIncident: boolean;
  };
  /** 生徒 (DailyEngine) の判断。 */
  student: {
    triggersIncident: boolean;
  };
}

/** ケースから evaluateRules 用の最小 Villager/env を復元する。 */
function contextOf(c: DivergenceCase): { villager: Villager; env: EnvironmentView } {
  const emotion: EmotionState = { axes: { ...c.villager.emotionAxes }, label: '' };
  // 気質 6 軸を完全な Personality に埋める (欠けは 0)。
  const traits = {} as Personality;
  for (const ax of PERSONALITY_AXES) traits[ax] = c.villager.traits[ax] ?? 0;
  const villager = {
    id: c.villager.id,
    name: c.villager.id,
    alive: true,
    persona: { traits, values: [] as string[], speechStyle: '' },
    emotion,
    information: c.villager.infoTexts.map((text, i) => ({
      id: `replay_${i}`,
      text,
      source: c.villager.infoFromPlayer ? ('player' as const) : ('observation' as const),
      termAcquired: c.term,
    })),
    position: { x: 0, y: 0 },
    appearance: { body: 'animal', descriptors: [] },
    species: c.villager.species,
    activity: 'always' as const,
    reformCount: 0,
    madman: false,
    stress: c.villager.stress,
    partnerId: null,
    origin: 'seed' as const,
    eventParams: { ...c.villager.eventParams },
    wealth: c.villager.wealth,
    hobby: 'ascetic' as const,
    admireId: null,
    scummy: false,
  } satisfies Villager;
  const env: EnvironmentView = {
    position: { x: 0, y: 0 },
    place: c.env.place,
    timeOfDay: c.env.timeOfDay,
    nearby: c.env.hasNeighbor ? [{ id: 'replay_n', name: 'replay_n', pos: { x: 1, y: 1 } }] : [],
    ...(c.env.placeState !== undefined ? { placeState: c.env.placeState } : {}),
  };
  return { villager, env };
}

const EPS = 1e-9;

function sign(n: number): -1 | 0 | 1 {
  if (n > EPS) return 1;
  if (n < -EPS) return -1;
  return 0;
}

/** 教師の感情変化のうち最も大きく動いた軸 (無ければ null)。 */
function teacherPrimaryAxis(c: DivergenceCase): string | null {
  let best: string | null = null;
  let bestAbs = EPS;
  for (const [axis, d] of Object.entries(c.teacher.emotionDelta)) {
    if (Math.abs(d) > bestAbs) {
      bestAbs = Math.abs(d);
      best = axis;
    }
  }
  return best;
}

/**
 * ルール集合と乖離ケース群の一致率 (0..1)。ケースごとに:
 * - 感情一致 (0.5): 教師が最も動かした感情軸の符号と、ルール評価の同軸 delta の符号が一致
 *   (教師が動かしていなければ、ルール側も動かさないことが一致)。
 * - 事件傾向一致 (0.5): (triggerWeight > 0) が教師の triggersIncident と一致。
 */
export function agreementRate(rules: readonly BehaviorRule[], cases: readonly DivergenceCase[]): number {
  if (cases.length === 0) return 0;
  let total = 0;
  for (const c of cases) {
    const { villager, env } = contextOf(c);
    const r = evaluateRules(rules, { villager, env, category: c.category });
    const axis = teacherPrimaryAxis(c);
    const emoMatch = axis === null ? Object.values(r.emotionDeltas).every((d) => sign(d) === 0) : sign(r.emotionDeltas[axis] ?? 0) === sign(c.teacher.emotionDelta[axis] ?? 0);
    const trigMatch = r.triggerWeight > 0 === c.teacher.triggersIncident;
    total += (emoMatch ? 0.5 : 0) + (trigMatch ? 0.5 : 0);
  }
  return total / cases.length;
}

export interface AdoptDecision {
  adopt: boolean;
  /** 既存ルールだけの一致率。 */
  before: number;
  /** 新ルールを足した一致率。 */
  after: number;
}

/**
 * 蒸留ルールの採否 (§v1.4-C)。乖離ケースへの教師一致率が acceptGain 以上改善するときだけ採用。
 * 改善しないルールは「もっともらしいが村を教師に近づけない」ので棄却する。
 */
export function shouldAdoptRule(
  existingRules: readonly BehaviorRule[],
  newRule: BehaviorRule,
  cases: readonly DivergenceCase[],
  acceptGain: number,
): AdoptDecision {
  const before = agreementRate(existingRules, cases);
  const after = agreementRate([...existingRules, newRule], cases);
  return { adopt: after >= before + acceptGain, before, after };
}
