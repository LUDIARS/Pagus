// 決定的な stub Brain。test と、LLM 未配線の開発初期 (v0.1) で使う。
// LLM を一切呼ばず、固定ロジックで起承転結を一巡させられる。

import type { Brain, ActionContext, ActionDecision, EmotionContext, IncidentContext, IncidentStep, TrialContext, TrialRound, EducationContext } from './brain.js';
import type { EmotionState, Reform } from './types/index.js';

export interface StubBrainOptions {
  /** decideAction がこの回数に達し、かつ周囲に村人がいれば事件を発火する。 */
  triggerAfter?: number;
  /** 承 1 ステップあたりの被害増分。 */
  damagePerStep?: number;
}

export class StubBrain implements Brain {
  private actionCount = 0;

  constructor(private readonly opts: StubBrainOptions = {}) {}

  async updateEmotion(ctx: EmotionContext): Promise<EmotionState> {
    return ctx.villager.emotion;
  }

  async decideAction(ctx: ActionContext): Promise<ActionDecision> {
    this.actionCount += 1;
    const hasNeighbor = ctx.environment.nearby.length > 0;
    const trigger = hasNeighbor && this.actionCount >= (this.opts.triggerAfter ?? 3);
    return {
      move: { x: ctx.villager.position.x + 1, y: ctx.villager.position.y },
      action: `${ctx.villager.name} は ${ctx.environment.place} をうろついた`,
      newEmotion: ctx.villager.emotion,
      triggersIncident: trigger,
      incidentSeed: trigger
        ? {
            description: `${ctx.villager.name} が ${ctx.environment.place} で騒ぎを起こした`,
            involved: ctx.environment.nearby.map((n) => n.id),
          }
        : null,
    };
  }

  async advanceIncident(ctx: IncidentContext): Promise<IncidentStep> {
    return {
      action: `${ctx.perspective === 'perpetrator' ? '加害者' : '被害者'}視点の応酬`,
      damageDelta: this.opts.damagePerStep ?? 4,
      ended: false,
    };
  }

  async judgeRound(_ctx: TrialContext): Promise<TrialRound> {
    return {
      winner: 'victim',
      perpetratorClaim: '正当な理由があった',
      victimClaim: '一方的に被害を受けた',
      judgement: '被害が甚大であり被害者の訴えを認める',
    };
  }

  async decideEducation(ctx: EducationContext): Promise<Reform> {
    return {
      kind: 'educate',
      villager: ctx.perpetrator.id,
      rationale: '攻撃性を矯正し穏やかな体に作り替える',
      persona: { traits: { aggression: -0.5 } },
      appearance: { body: 'machine', descriptors: ['穏やかな目'] },
    };
  }
}
