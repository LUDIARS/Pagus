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

/**
 * DSL のバージョン (§v1.4-C)。蒸留の受け皿として v2 で 情報/ストレス/感情下限 条件と
 * 噂伝播/移動バイアス/所持金 効果を追加した。coerce (server) は未知 kind を reject する。
 */
export const RULE_DSL_VERSION = 2;

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
  | { kind: 'actionCategory'; category: RuleCategory }
  | { kind: 'wealthBelow'; value: number } // 所持金 < value (§15 貧困=非行傾向)
  | { kind: 'wealthAbove'; value: number } // 所持金 >= value (§15 富裕=クズ化)
  | { kind: 'placeState'; state: 'defiled' | 'blessed' } // いる場所の状態 (§v1.4-A' spot)
  // --- v2 (§v1.4-C 蒸留の受け皿) ---
  | { kind: 'infoContains'; substr: string } // 持っている情報 (InfoItem) の本文に substr を含む
  | { kind: 'infoFromPlayer' } // プレイヤー由来の情報 (扇動の噂 等) を持っている
  | { kind: 'stressAbove'; value: number } // ストレス耐性 > value
  | { kind: 'emotionBelow'; emotionAxis: string; value: number }; // 感情軸 < value

/** ルール効果 (閉じた enum)。match した全ルールの効果を集約する。 */
export type RuleEffect =
  | { kind: 'emotionDelta'; emotionAxis: string; delta: number }
  | { kind: 'triggerWeight'; delta: number }
  | { kind: 'actionFlavor'; text: string }
  // --- v2 (§v1.4-C) ---
  | { kind: 'spreadInfo' } // 最新の情報を近傍 1 体へ伝える (噂の自然伝播)
  | { kind: 'moveBias'; towards: 'partner' | 'admire' | 'awayMadman' } // 移動の重み付け
  | { kind: 'wealthDelta'; delta: number }; // 所持金の増減 (下限 0)

/** ふるまいの法則 1 件。base = 組込み / haiku = 生成由来 / card = カード(天災)由来の一時効果。 */
export interface BehaviorRule {
  id: string;
  source: 'base' | 'haiku' | 'card' | 'distill';
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
  /** 最新の情報を近傍へ伝えるか (v2, いずれかの match ルールが指示したら true)。 */
  spreadInfo: boolean;
  /** 移動の重み付け (v2, 最後の match を採用、無ければ null)。 */
  moveBias: 'partner' | 'admire' | 'awayMadman' | null;
  /** 所持金の増減 (v2, 加算集約)。 */
  wealthDelta: number;
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
    case 'wealthBelow':
      return villager.wealth < cond.value;
    case 'wealthAbove':
      return villager.wealth >= cond.value;
    case 'placeState':
      return env.placeState === cond.state;
    case 'infoContains':
      return villager.information.some((i) => i.text.includes(cond.substr));
    case 'infoFromPlayer':
      return villager.information.some((i) => i.source === 'player');
    case 'stressAbove':
      return villager.stress > cond.value;
    case 'emotionBelow':
      return (villager.emotion.axes[cond.emotionAxis] ?? 0) < cond.value;
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
  let spreadInfo = false;
  let moveBias: RuleEvalResult['moveBias'] = null;
  let wealthDelta = 0;
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
        case 'spreadInfo':
          spreadInfo = true;
          break;
        case 'moveBias':
          moveBias = eff.towards;
          break;
        case 'wealthDelta':
          wealthDelta += eff.delta;
          break;
      }
    }
  }
  return { emotionDeltas, triggerWeight, flavor, spreadInfo, moveBias, wealthDelta };
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
  // §15 住民経済: 閾値は economy.ts の DEFAULT_ECONOMY と一致させること (poorThreshold=40 / scumThreshold=400)。
  {
    id: 'base_poor_delinquency',
    source: 'base',
    description: '金に困った者は気が立ち、非行 (事件) に走りやすい',
    when: [
      { kind: 'actionCategory', category: 'wander' },
      { kind: 'wealthBelow', value: 40 },
    ],
    then: [
      { kind: 'triggerWeight', delta: 2 },
      { kind: 'emotionDelta', emotionAxis: 'anger', delta: 0.1 },
    ],
  },
  {
    id: 'base_rich_scum',
    source: 'base',
    description: '大金を持つと横柄になり、諍いの火種になりやすい',
    when: [
      { kind: 'actionCategory', category: 'wander' },
      { kind: 'wealthAbove', value: 400 },
    ],
    then: [
      { kind: 'triggerWeight', delta: 1 },
      { kind: 'emotionDelta', emotionAxis: 'joy', delta: 0.05 },
    ],
  },
  // §v1.4-A' spot: 荒らされた場所は気が立ち事件が起きやすく、清められた場所は和む。
  {
    id: 'base_defiled_place',
    source: 'base',
    description: '穢れた場所では気が立ち、諍いが起きやすい',
    when: [
      { kind: 'actionCategory', category: 'wander' },
      { kind: 'placeState', state: 'defiled' },
    ],
    then: [
      { kind: 'triggerWeight', delta: 1 },
      { kind: 'emotionDelta', emotionAxis: 'anger', delta: 0.06 },
    ],
  },
  {
    id: 'base_blessed_place',
    source: 'base',
    description: '清められた場所では心が和む',
    when: [
      { kind: 'actionCategory', category: 'wander' },
      { kind: 'placeState', state: 'blessed' },
    ],
    then: [{ kind: 'emotionDelta', emotionAxis: 'joy', delta: 0.04 }],
  },
  // §16 アイテム: 薬物を拾った個体 (eventParam 'drug' > 0、items.ts の DRUG_TAG と一致) は非行に走りやすい。
  {
    id: 'base_drugged',
    source: 'base',
    description: '薬物に手を出した者は気が荒れ、非行に走りやすい',
    when: [
      { kind: 'actionCategory', category: 'wander' },
      { kind: 'eventParamAbove', tag: 'drug', value: 0 },
    ],
    then: [
      { kind: 'triggerWeight', delta: 2 },
      { kind: 'emotionDelta', emotionAxis: 'anger', delta: 0.1 },
    ],
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
