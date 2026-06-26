// 決定的な stub Brain。test と、LLM 未配線の開発初期 (v0.1) で使う。
// LLM を一切呼ばず、固定ロジックで起承転結を一巡させられる。

import type { Brain, ActionContext, ActionDecision, EmotionContext, IncidentContext, IncidentStep, FoolishVoteContext, FateVoteContext, EducationContext } from './brain.js';
import type { WorldBrain, WorldEvalContext, DayEvaluation, HolidayContext, HolidayEvent } from './world-brain.js';
import type { EmotionState, Reform, VillagerId } from './types/index.js';

export interface StubBrainOptions {
  /** decideAction がこの回数に達し、かつ周囲に村人がいれば事件を発火する。 */
  triggerAfter?: number;
  /** 承 1 ステップあたりの被害増分。 */
  damagePerStep?: number;
}

export class StubBrain implements Brain {
  private actionCount = 0;
  private forced = false;

  constructor(private readonly opts: StubBrainOptions = {}) {}

  /** 次に周囲がいる村人が行動するとき、強制的に事件を発火させる (プレイヤーの扇動)。 */
  forceNext(): void {
    this.forced = true;
  }

  async updateEmotion(ctx: EmotionContext): Promise<EmotionState> {
    return ctx.villager.emotion;
  }

  async decideAction(ctx: ActionContext): Promise<ActionDecision> {
    const move = { x: ctx.villager.position.x + 1, y: ctx.villager.position.y };
    if (ctx.directive) return this.narrate(ctx, move);

    // directive 無し (自由行動パス): カウンタ/扇動で事件を起こす。
    this.actionCount += 1;
    const hasNeighbor = ctx.environment.nearby.length > 0;
    const trigger = hasNeighbor && (this.forced || this.actionCount >= (this.opts.triggerAfter ?? 3));
    if (trigger) this.forced = false;
    return {
      move,
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

  /** EventDirector が差配したイベントを narration する。嫌がらせは事件化。 */
  private narrate(ctx: ActionContext, move: { x: number; y: number }): ActionDecision {
    const d = ctx.directive!;
    const name = ctx.villager.name;
    if (d.category === 'harass' && d.target) {
      return {
        move,
        action: `${name} は誰かに嫌がらせをした`,
        newEmotion: ctx.villager.emotion,
        triggersIncident: true,
        incidentSeed: { description: `${name} が嫌がらせをした`, involved: [d.target] },
      };
    }
    const text =
      d.category === 'good' ? `${name} は ${ctx.environment.place} で良い行いをした` : `${name} は雑談した`;
    return { move, action: text, newEmotion: ctx.villager.emotion, triggersIncident: false, incidentSeed: null };
  }

  async advanceIncident(ctx: IncidentContext): Promise<IncidentStep> {
    return {
      action: `${ctx.perspective === 'perpetrator' ? '加害者' : '被害者'}視点の応酬`,
      damageDelta: this.opts.damagePerStep ?? 4,
      ended: false,
    };
  }

  async groupVoteFoolish(ctx: FoolishVoteContext): Promise<VillagerId> {
    // 攻撃性が最も高い候補を「最も愚か」とみなす (≈ 加害者)。
    const first = ctx.candidates[0];
    if (!first) throw new Error('候補がいません');
    let pick = first;
    for (const c of ctx.candidates) {
      if (c.persona.traits.aggression > pick.persona.traits.aggression) pick = c;
    }
    return pick.id;
  }

  async groupVoteFate(ctx: FateVoteContext): Promise<'kill' | 'spare'> {
    // 厳格な軸 (攻撃性/規律/野心) のグループは死刑寄り、他は活かす寄り。
    return ctx.axis === 'aggression' || ctx.axis === 'discipline' || ctx.axis === 'ambition'
      ? 'kill'
      : 'spare';
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

/** 決定的な世界側 LLM。裁判結果から村の徳目評判と新規出生を決める。 */
export class StubWorldBrain implements WorldBrain {
  async evaluateDay(ctx: WorldEvalContext): Promise<DayEvaluation> {
    if (ctx.verdict === 'death') {
      return {
        reputationDelta: { malice: 0.12, order: 0.08 },
        villagerDeltas: [],
        spawn: 1,
        narrative: `${ctx.defendant.name} は処刑され、村は厳しさを増した`,
      };
    }
    return {
      reputationDelta: { benevolence: 0.12, vitality: 0.05 },
      villagerDeltas: [{ villager: ctx.defendant.id, personalityDelta: { aggression: -0.2, kindness: 0.2 } }],
      spawn: 1,
      narrative: `${ctx.defendant.name} は教育され、村に優しさが芽生えた`,
    };
  }

  async holidayEvent(ctx: HolidayContext): Promise<HolidayEvent> {
    // 祝祭は村に活気と善良さをわずかに灯す (決定的)。
    const cheer = ctx.villagers[0]?.name ?? '村のみんな';
    return {
      reputationDelta: { vitality: 0.06, benevolence: 0.03 },
      narrative: `${ctx.holiday}を迎え、${cheer}たちが集って村は賑わった`,
    };
  }
}
