import type { ActionDecision } from './brain.js';
import type { Villager, World } from './types/index.js';
import { branch, leaf, selector } from './behavior-tree.js';
import { decideWithTree } from './resident-bt-trace.js';
import { isAwake } from './calendar.js';
import { currentIntervention } from './resident-interventions.js';

/** The daily proposal tree includes sleep, accepted interventions and learned rules. */
export function residentDailyTree(world: World, v: Villager, learned: () => ActionDecision): ActionDecision {
  const quiet = (action: string): ActionDecision => ({ move: null, action, newEmotion: v.emotion, triggersIncident: false, incidentSeed: null });
  return decideWithTree(v, 'daily', selector<World, ActionDecision>('daily', [
    branch('sleep', w => !isAwake(v.activity, w.calendar.segment, w.config.segmentsPerDay), () => quiet(`${v.name}は寝床に戻って休む`)),
    branch('calming-intervention', w => currentIntervention(w, v)?.intent === 'calm', () => {
      const axes = { ...v.emotion.axes, anger: Math.max(-1, (v.emotion.axes['anger'] ?? 0) - .15) };
      return { ...quiet(`${v.name}は聞いた提案を受け、落ち着いて考える`), newEmotion: { axes, label: '考え直している' } };
    }),
    branch('isolation-recovery', () => v.townLife?.housing === 'isolated', () => quiet(`${v.name}は離れで休養し、平穏な暮らしを取り戻している`)),
    leaf('learned-behavior-and-relationships', learned),
  ]), world, value => value.action);
}
