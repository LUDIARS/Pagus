import type { Villager, World } from './types/index.js';
import type { ActionDecision } from './brain.js';
import type { ResidentGoal } from './resident-goals.js';
import { isAwake } from './calendar.js';

/** Propose nearby conversation before the education gate, retaining incident/rule proposals. */
export function socialAction(world: World, v: Villager, goal: ResidentGoal, proposed: ActionDecision): ActionDecision {
  if (goal.kind !== 'social' || goal.interrupted || proposed.triggersIncident || proposed.relationshipEffects?.length) return proposed;
  const target = [...world.villagers.values()].filter(n => n.id !== v.id && n.alive
    && (n.hiddenUntilTerm ?? -1) <= world.term && n.townLife?.housing !== 'isolated'
    && isAwake(n.activity, world.calendar.segment, world.config.segmentsPerDay)
    && Math.hypot(n.position.x-v.position.x,n.position.y-v.position.y) <= 2)
    .sort((a,b)=>a.id.localeCompare(b.id))[0];
  if (!target) return proposed;
  const swagger = v.persona.traits.aggression > .6;
  const lines = swagger ? ['おい、今日は何してるんだ？', 'この辺は俺に任せとけよ。', 'さっきの話、聞かせてもらおうか。']
    : ['今日はどんな一日だった？', '広場で少し話していかない？', '最近、村で何かあった？'];
  const line = lines[(world.term + world.calendar.segment) % lines.length]!;
  // Swagger is presentation only (PA-PRESENCE-01). Scoring it as 'harass' would raise the
  // target's townHarassment every free segment and exile an innocent neighbour to the
  // isolation hut after six ordinary greetings; only authored incidents may claim that.
  return { ...proposed, action: `${v.name}は${target.name}に${swagger ? '肩を揺らして声をかける' : '話しかける'}「${line}」`,
    relationshipEffects: [{kind: 'chat', targetIds:[target.id]}] };
}
