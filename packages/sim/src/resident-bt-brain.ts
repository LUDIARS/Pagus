import type { Brain, ActionContext, EmotionContext, IncidentContext, FoolishVoteContext, FateVoteContext, EducationContext, ActionDecision, IncidentStep } from './brain.js';
import type { EmotionState, Reform } from './types/index.js';
import { branch, leaf, selector } from './behavior-tree.js';
import { decideWithTree } from './resident-bt-trace.js';
import { educationTree, fateTree, foolishTree } from './resident-trial-tree.js';
import { educationHolds, educationPartsFor } from './education-profile.js';

/** Production resident decisions: no model client, IO, or substitute stub. */
export class ResidentBtBrain implements Brain {
  async updateEmotion(ctx: EmotionContext): Promise<EmotionState> {
    return decideWithTree(ctx.villager, 'emotion', leaf<EmotionContext, EmotionState>('emotion/retain-observed-state', c => ({ ...c.villager.emotion, axes: { ...c.villager.emotion.axes } })), ctx, value => value.label);
  }
  async decideAction(ctx: ActionContext): Promise<ActionDecision> {
    return decideWithTree(ctx.villager, 'action', leaf<ActionContext, ActionDecision>('action/routine', c => ({ move: null, action: c.environment.townActivity ?? '周囲を観察する', newEmotion: c.villager.emotion, triggersIncident: false, incidentSeed: null })), ctx, value => value.action);
  }
  async advanceIncident(ctx: IncidentContext): Promise<IncidentStep> {
    const actor = ctx.perspective === 'perpetrator' ? ctx.perpetrator : ctx.victims[0] ?? ctx.perpetrator;
    return decideWithTree(actor, 'incident', selector<IncidentContext, IncidentStep>('incident', [
      // Recency-bounded, not trait-bounded: a trait gate would end every incident an
      // educated resident is party to, forever. See educationHolds.
      branch('education-gate', c => c.term !== undefined && educationHolds(actor, c.term)
        && (educationPartsFor(actor).includes('tentacles') || educationPartsFor(actor).includes('clockwork')),
        () => ({ action: `${actor.name}は手を止め、相手の話を聞く`, damageDelta: 0, ended: true })),
      branch('seek-help', () => ctx.perspective === 'victim' && (actor.emotion.axes['fear'] ?? 0) > .4,
        () => ({ action: `${actor.name}は距離を取り、助けを求める`, damageDelta: 1, ended: false })),
      branch('escalate', () => actor.persona.traits.aggression > actor.persona.traits.discipline,
        () => ({ action: `${actor.name}は相手に詰め寄って言い争う`, damageDelta: 3, ended: false })),
      leaf('exchange-accounts', () => ({ action: `${actor.name}は自分の見聞きを説明し、広場での審議を求める`, damageDelta: 1, ended: ctx.incident.steps.length >= 5 })),
    ]), ctx, value => value.action);
  }
  async groupVoteFoolish(ctx: FoolishVoteContext): Promise<string> { return foolishTree(ctx); }
  async groupVoteFate(ctx: FateVoteContext): Promise<'kill' | 'spare'> { return fateTree(ctx); }
  async decideEducation(ctx: EducationContext): Promise<Reform> { return educationTree(ctx); }
}
