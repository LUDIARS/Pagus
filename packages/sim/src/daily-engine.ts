// 日常エンジン (BT / ブラックボックス) — LLM を一切呼ばずに起の行動を決める (§12.2)。
//
// コスト削減リデザイン v1.0: 日常 (起の毎セグメント) から LLM を外し、決定的な
// ルール/重み + アルゴリズム感情変異で行動を生成する。LLM は事件デザイン・事件中の
// 当事者応答・裁判だけに限定する (Brain interface 越し)。
//
// EventDirector が差配する directive (グループ代表 × カテゴリ) を narration し、
// 嫌がらせは事件化させる。directive 無し (自由行動) は行動回数・扇動・イベント由来
// パラメータ (§12.6) を踏まえて確率的に事件化する。

import type { Villager, EmotionState } from './types/index.js';
import type { ActionDecision, EnvironmentView } from './brain.js';
import type { EventDirective } from './events.js';
import {
  evaluateRules,
  applyEmotionDeltas,
  defaultBehaviorRules,
  type BehaviorRule,
  type RuleCategory,
} from './behavior-rules.js';
import { routineActionFor, specialtyIncidentSeed, specialtyTriggerWeight } from './life-profile.js';

/** 事件をくぐった反応として溜まるイベント由来パラメータのタグ。 */
export const REACTION_EXPOSURE = 'incidentExposure';

export interface DailyEngineOptions {
  /** 乱数源 (既定 Math.random)。 */
  rng?: () => number;
  /**
   * 自由行動がこの回数に達すると (周囲に住民がいれば) 事件化する。既定 6。
   * 扇動 (forceNext) と イベント由来パラメータ (§12.6)・ルールの triggerWeight で前倒しされる。
   */
  triggerAfter?: number;
  /** ふるまいの法則 (§2.1)。既定 = base ルール (旧 nudgeEmotion を再現)。 */
  behaviorRules?: BehaviorRule[];
}

/**
 * 日常 (起) の行動を LLM 非依存で決める。TermMachine が kishoTick から呼ぶ。
 * 状態 (行動カウンタ・扇動フラグ) を持つので TermMachine が 1 個保持する。
 * 感情/行動は ふるまいの法則 (BehaviorRule) の決定的評価で決まる (§2.1)。
 */
export class DailyEngine {
  private readonly rng: () => number;
  private readonly triggerAfter: number;
  /** ふるまいの法則。TermMachine が setRules で world.behaviorRules を流し込む。 */
  private rules: BehaviorRule[];
  /** プレイヤーの扇動: 次に周囲がいる自由行動で必ず事件化する (対象不問)。 */
  private forced = false;
  /** プレイヤーの対象指定扇動: この id の自由行動で (周囲がいれば) 必ず事件化する (§4.2)。 */
  private forcedTargetId: string | null = null;
  /** 戒厳令 surge (§v1.3-C ⑨): 事件化閾値をこの分だけ下げる (0 = 平時)。 */
  private surgeBonus = 0;

  constructor(opts: DailyEngineOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.triggerAfter = opts.triggerAfter ?? 6;
    this.rules = opts.behaviorRules ?? defaultBehaviorRules();
  }

  /** 評価に使うルールを差し替える (TermMachine が world.behaviorRules を流し込む)。 */
  setRules(rules: BehaviorRule[]): void {
    this.rules = rules;
  }

  /**
   * 戒厳令 surge の閾値ボーナスを設定する (§v1.3-C ⑨)。bonus>0 で自由行動の事件化閾値が下がり多発する。
   * TermMachine が kishoTick で world.martial に応じて毎回設定する (surge 解除で 0 に戻る)。
   */
  setSurge(bonus: number): void {
    this.surgeBonus = Math.max(0, bonus);
  }

  /** カテゴリでルール評価し、base 感情に効果を反映した感情・flavor・副作用 (v2) を返す。 */
  private evalFor(
    villager: Villager,
    env: EnvironmentView,
    category: RuleCategory,
  ): { emotion: EmotionState; flavor: string | null; sideEffects: ActionDecision['sideEffects'] } {
    const r = evaluateRules(this.rules, { villager, env, category });
    // 副作用 (DSL v2, §v1.4-C): 指示があるときだけキーを組む (exactOptionalPropertyTypes)。
    let sideEffects: ActionDecision['sideEffects'];
    if (r.spreadInfo || r.moveBias !== null || r.wealthDelta !== 0) {
      sideEffects = {
        ...(r.spreadInfo ? { spreadInfo: true } : {}),
        ...(r.moveBias !== null ? { moveBias: r.moveBias } : {}),
        ...(r.wealthDelta !== 0 ? { wealthDelta: r.wealthDelta } : {}),
      };
    }
    return { emotion: applyEmotionDeltas(villager.emotion, r.emotionDeltas), flavor: r.flavor, sideEffects };
  }

  /** プレイヤーの扇動 (§12.4)。次の自由行動で事件化を促す (対象不問)。 */
  forceNext(): void {
    this.forced = true;
  }

  /** プレイヤーの対象指定扇動 (§4.2)。指定 id の次の自由行動で事件化を促す。 */
  forceFor(id: string): void {
    this.forcedTargetId = id;
  }

  /** 起の 1 行動を決める。directive があれば差配を narration、無ければ自由行動。 */
  decide(villager: Villager, env: EnvironmentView, directive: EventDirective | null): ActionDecision {
    // Actual movement is selected by the resident's goal tree at the application boundary.
    const move = { ...villager.position };
    if (directive) return this.narrate(villager, env, directive, move);
    return this.freeAction(villager, env, move);
  }

  /** directive 無しの自由行動。カウンタ/扇動/イベント由来パラメータ/ルール重みで事件化する。 */
  private freeAction(villager: Villager, env: EnvironmentView, move: { x: number; y: number }): ActionDecision {
    // Per-villager, not a single engine-wide counter: previously any villager's action
    // advanced one shared count, so the threshold was reached ~N× faster with N villagers
    // and the trigger jumped between unrelated residents. Resetting on trigger makes
    // triggerAfter mean "actions since this villager's last incident", which is what the
    // §12.2 threshold documents. Both slow the legacy cadence relative to the old shared
    // counter; that is the intended correction, not an incidental side effect.
    const actionCount = (villager.eventParams['dailyActionCount'] ?? 0) + 1;
    villager.eventParams['dailyActionCount'] = actionCount;
    const hasNeighbor = env.nearby.length > 0;
    // イベント由来パラメータ (殺人を見た等) が高い個体ほど閾値が下がり、事件を起こしやすい。
    const exposure = villager.eventParams[REACTION_EXPOSURE] ?? 0;
    // ルールの triggerWeight (wander カテゴリで評価) も閾値を下げる (§2.1)。
    const ruleTriggerWeight = evaluateRules(this.rules, { villager, env, category: 'wander' }).triggerWeight;
    // 職能・日課由来の火種も閾値を下げる。音楽家の夜演奏、収集家の盗難疑惑など。
    const specialtyWeight = specialtyTriggerWeight(villager, env);
    // 戒厳令 surge (§v1.3-C ⑨) は閾値を surgeBonus だけ下げて事件を多発させる。
    const threshold = Math.max(1, this.triggerAfter - exposure - ruleTriggerWeight - specialtyWeight - this.surgeBonus);
    // 対象指定扇動: この個体が指名されていれば即事件化を促す。
    const targeted = this.forcedTargetId === villager.id;
    const forcedTrigger = hasNeighbor && (this.forced || targeted);
    const trigger = forcedTrigger || (hasNeighbor && actionCount >= threshold);
    if (trigger) {
      villager.eventParams['dailyActionCount'] = 0;
      this.forced = false;
      if (targeted) this.forcedTargetId = null;
    }
    // 最終カテゴリ (発火時は興奮 = harass 相当) でルール評価し感情・flavor・副作用を得る。
    const { emotion, flavor, sideEffects } = this.evalFor(villager, env, trigger ? 'harass' : 'wander');
    const targetIds = trigger ? env.nearby.map((n) => n.id) : [];
    const routineText = flavor ?? (env.townActivity ? `${villager.name}は${env.townActivity}` : routineActionFor(villager, env));
    return {
      ...(sideEffects ? { sideEffects } : {}),
      move,
      action: routineText,
      newEmotion: emotion,
      triggersIncident: trigger,
      incidentSeed: trigger
        ? {
            description: specialtyIncidentSeed(villager, env),
            involved: env.nearby.map((n) => n.id),
          }
        : null,
      ...(targetIds.length > 0 ? { relationshipEffects: [{ kind: 'harass' as const, targetIds }] } : {}),
      // 扇動由来の事件化は小騒動 (§v1.4-B) に流さない。
      ...(forcedTrigger ? { forcedTrigger: true } : {}),
    };
  }

  /** EventDirector が差配したイベントを narration する。嫌がらせは事件化。 */
  private narrate(
    villager: Villager,
    env: EnvironmentView,
    d: EventDirective,
    move: { x: number; y: number },
  ): ActionDecision {
    const name = villager.name;
    if (d.category === 'harass' && d.target) {
      const { emotion, flavor, sideEffects } = this.evalFor(villager, env, 'harass');
      return {
        ...(sideEffects ? { sideEffects } : {}),
        move,
        action: flavor ?? `${name} は誰かに嫌がらせをした`,
        newEmotion: emotion,
        triggersIncident: true,
        incidentSeed: { description: `${name} が嫌がらせをした`, involved: [d.target] },
        relationshipEffects: [{ kind: 'harass', targetIds: [d.target] }],
      };
    }
    const category: RuleCategory = d.category === 'good' ? 'good' : 'chat';
    const { emotion, flavor, sideEffects } = this.evalFor(villager, env, category);
    const text = flavor ?? (d.category === 'good' ? `${name} は ${env.place} で良い行いをした` : `${name} は雑談した`);
    const targetIds = this.socialTargets(env, d.category === 'good' ? 3 : 2);
    return {
      ...(sideEffects ? { sideEffects } : {}),
      move,
      action: text,
      newEmotion: emotion,
      triggersIncident: false,
      incidentSeed: null,
      ...(targetIds.length > 0 ? { relationshipEffects: [{ kind: d.category === 'good' ? 'good' : 'chat', targetIds }] } : {}),
    };
  }

  private socialTargets(env: EnvironmentView, max: number): string[] {
    if (env.nearby.length === 0) return [];
    const pool = [...env.nearby];
    const out: string[] = [];
    while (pool.length > 0 && out.length < max) {
      const idx = Math.floor(this.rng() * pool.length);
      const picked = pool.splice(idx, 1)[0];
      if (picked) out.push(picked.id);
    }
    return out;
  }
}
