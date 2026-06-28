// ふるまいの法則 (BehaviorRule) — 感情/行動をデータ駆動ルール群の決定的評価で決める (§2.1)。
//
// 固定アルゴリズム (旧 nudgeEmotion) を、安全な閉じた DSL のルール集合に置き換える。
// 条件 (when) は AND、効果 (then) は集約 (emotionDelta は加算 / triggerWeight は加算 /
// flavor は最後の match を採用)。任意コード実行はせず enum + switch で評価する。
//
// Haiku が日末に低確率でルールを 1 つ増やす (RuleSmith)。base ルールは旧挙動を完全再現し
// 退行ゼロを保つ。日常 tick は本評価のみで動き LLM を呼ばない。

import type { PersonalityAxis } from './personality.js';
import type { TimeOfDay } from './types/world.js';
import type { Villager, EmotionState } from './types/index.js';
import type { EnvironmentView } from './brain.js';

/** 行動カテゴリ (差配/自由行動から決まる)。ルール条件 actionCategory と評価コンテキストの両方で使う。 */
export type RuleCategory = 'harass' | 'good' | 'chat' | 'wander';

/** ルール条件 (閉じた enum)。全条件 AND で match させる。 */
export type RuleCondition =
  | { kind: 'traitAbove'; axis: PersonalityAxis; value: number }
  | { kind: 'traitBelow'; axis: PersonalityAxis; value: number }
  | { kind: 'emotionAbove'; emotionAxis: string; value: number }
  | { kind: 'eventParamAbove'; tag: string; value: number }
  | { kind: 'place'; place: string }
  | { kind: 'timeOfDay'; timeOfDay: TimeOfDay }
  | { kind: 'hasNeighbor' }
  | { kind: 'species'; species: string }
  | { kind: 'actionCategory'; category: RuleCategory };

/** ルール効果 (閉じた enum)。match した全ルールの効果を集約する。 */
export type RuleEffect =
  | { kind: 'emotionDelta'; emotionAxis: string; delta: number }
  | { kind: 'triggerWeight'; delta: number }
  | { kind: 'actionFlavor'; text: string };

/** ふるまいの法則 1 件。base = 組込み / haiku = 生成由来 / card = カード(天災)由来の一時効果。 */
export interface BehaviorRule {
  id: string;
  source: 'base' | 'haiku' | 'card';
  description: string;
  when: RuleCondition[];
  then: RuleEffect[];
  /**
   * 失効するターム (§v1.3 TTL)。expiresAtTerm <= world.term になったら除去される。
   * 値があるときだけキーを足す (exactOptionalPropertyTypes)。常設ルールは未設定。
   */
  expiresAtTerm?: number;
}

/** ルール評価のコンテキスト。category は最終的に決まった行動カテゴリ。 */
export interface RuleEvalContext {
  villager: Villager;
  env: EnvironmentView;
  category: RuleCategory;
}

/** ルール評価の集約結果。 */
export interface RuleEvalResult {
  /** 感情軸ごとの増減 (加算集約)。 */
  emotionDeltas: Record<string, number>;
  /** 事件化しやすさの加減 (加算集約)。 */
  triggerWeight: number;
  /** 行動文の差し替え (最後に match したルールを採用、無ければ null)。 */
  flavor: string | null;
}

/** 1 条件が現在のコンテキストに合致するか (閉じた switch)。 */
function matchCondition(cond: RuleCondition, ctx: RuleEvalContext): boolean {
  const { villager, env, category } = ctx;
  switch (cond.kind) {
    case 'traitAbove':
      return villager.persona.traits[cond.axis] > cond.value;
    case 'traitBelow':
      return villager.persona.traits[cond.axis] < cond.value;
    case 'emotionAbove':
      return (villager.emotion.axes[cond.emotionAxis] ?? 0) > cond.value;
    case 'eventParamAbove':
      return (villager.eventParams[cond.tag] ?? 0) > cond.value;
    case 'place':
      return env.place === cond.place;
    case 'timeOfDay':
      return env.timeOfDay === cond.timeOfDay;
    case 'hasNeighbor':
      return env.nearby.length > 0;
    case 'species':
      return villager.species === cond.species;
    case 'actionCategory':
      return category === cond.category;
  }
}

/**
 * ルール群を決定的に評価する。条件は AND、効果は集約:
 * emotionDelta は感情軸ごとに加算 / triggerWeight は加算 / flavor は最後の match を採用。
 */
export function evaluateRules(rules: readonly BehaviorRule[], ctx: RuleEvalContext): RuleEvalResult {
  const emotionDeltas: Record<string, number> = {};
  let triggerWeight = 0;
  let flavor: string | null = null;
  for (const rule of rules) {
    if (!rule.when.every((c) => matchCondition(c, ctx))) continue;
    for (const eff of rule.then) {
      switch (eff.kind) {
        case 'emotionDelta':
          emotionDeltas[eff.emotionAxis] = (emotionDeltas[eff.emotionAxis] ?? 0) + eff.delta;
          break;
        case 'triggerWeight':
          triggerWeight += eff.delta;
          break;
        case 'actionFlavor':
          flavor = eff.text;
          break;
      }
    }
  }
  return { emotionDeltas, triggerWeight, flavor };
}

/** 感情軸の値からラベルを言語化する (旧 nudgeEmotion と同一規則)。 */
export function emotionLabel(axes: Record<string, number>): string {
  return (axes['anger'] ?? 0) > 0.4 ? 'いらだち' : (axes['joy'] ?? 0) > 0.4 ? 'ごきげん' : 'ふつう';
}

/** 感情を -1..1 にクランプ。 */
function clampAxis(n: number): number {
  return Math.min(1, Math.max(-1, n));
}

/** 評価結果の emotionDeltas を base 感情に加算・クランプし、ラベルを付け直す。 */
export function applyEmotionDeltas(base: EmotionState, deltas: Record<string, number>): EmotionState {
  const axes = { ...base.axes };
  for (const [k, d] of Object.entries(deltas)) {
    axes[k] = clampAxis((axes[k] ?? 0) + d);
  }
  return { axes, label: emotionLabel(axes) };
}

/**
 * 組込みの base ルール。旧 daily-engine.ts の nudgeEmotion を完全再現する (退行ゼロ)。
 * harass → 怒り↑喜び↓ / good → 喜び↑怒り↓ / chat → 喜び↑ / wander → 怒り↓。
 */
export const BASE_BEHAVIOR_RULES: BehaviorRule[] = [
  {
    id: 'base_harass',
    source: 'base',
    description: '嫌がらせをすると怒りが昂り喜びがしぼむ',
    when: [{ kind: 'actionCategory', category: 'harass' }],
    then: [
      { kind: 'emotionDelta', emotionAxis: 'anger', delta: 0.2 },
      { kind: 'emotionDelta', emotionAxis: 'joy', delta: -0.1 },
    ],
  },
  {
    id: 'base_good',
    source: 'base',
    description: '良い行いをすると喜びが増し怒りが和らぐ',
    when: [{ kind: 'actionCategory', category: 'good' }],
    then: [
      { kind: 'emotionDelta', emotionAxis: 'joy', delta: 0.15 },
      { kind: 'emotionDelta', emotionAxis: 'anger', delta: -0.1 },
    ],
  },
  {
    id: 'base_chat',
    source: 'base',
    description: '雑談すると少し喜びが増す',
    when: [{ kind: 'actionCategory', category: 'chat' }],
    then: [{ kind: 'emotionDelta', emotionAxis: 'joy', delta: 0.05 }],
  },
  {
    id: 'base_wander',
    source: 'base',
    description: 'うろつくと怒りが緩やかに鎮まる',
    when: [{ kind: 'actionCategory', category: 'wander' }],
    then: [{ kind: 'emotionDelta', emotionAxis: 'anger', delta: -0.05 }],
  },
];

/** base ルールの独立コピーを作る (world ごとに別配列で持たせ、haiku 追加で汚染しない)。 */
export function defaultBehaviorRules(): BehaviorRule[] {
  return BASE_BEHAVIOR_RULES.map((r) => ({ ...r, when: [...r.when], then: [...r.then] }));
}

/** 天災カード (§v1.3-A ⑯) の種別。 */
export type DisasterKind = 'drought' | 'storm' | 'plague';

/**
 * 天災カードの一時 BehaviorRule を作る (§v1.3-A ⑯)。actionCategory 不問 (when は空 = 常時 match) で
 * 村全体へ効く。expiresAtTerm までの TTL 付き (source='card')。
 * drought → 苛立ち (anger+0.15) / storm → 事件多発 (triggerWeight+2) / plague → 気鬱 (joy-0.15)。
 */
export function makeDisasterRule(kind: DisasterKind, expiresAtTerm: number, id: string): BehaviorRule {
  const base = { id, source: 'card' as const, when: [] as RuleCondition[], expiresAtTerm };
  switch (kind) {
    case 'drought':
      return { ...base, description: '天災: 干ばつで村に苛立ちが募る', then: [{ kind: 'emotionDelta', emotionAxis: 'anger', delta: 0.15 }] };
    case 'storm':
      return { ...base, description: '天災: 嵐で諍いが起きやすい', then: [{ kind: 'triggerWeight', delta: 2 }] };
    case 'plague':
      return { ...base, description: '天災: 疫病で気が滅入る', then: [{ kind: 'emotionDelta', emotionAxis: 'joy', delta: -0.15 }] };
  }
}
