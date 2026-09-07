import type { Villager, World } from './types/index.js';
import { branch, leaf, selector } from './behavior-tree.js';
import { decideWithTree } from './resident-bt-trace.js';
import { isAwake } from './calendar.js';

export type ResidentIntent = 'calm' | 'investigate' | 'gather';
export interface ResidentIntervention { intent: ResidentIntent; source: 'llm' | 'player'; reason: string; untilTick: number }
export function currentIntervention(world: World, v: Villager): ResidentIntervention | null {
  const tick = world.term * world.config.segmentsPerDay + world.calendar.segment;
  const input = v.btIntervention;
  if (input && input.untilTick <= tick) { delete v.btIntervention; return null; }
  return input ?? null;
}
/** Untrusted proposals can request only a bounded intent, never executable actions or votes. */
export function offerIntervention(world: World, v: Villager, input: { intent: ResidentIntent; source: ResidentIntervention['source']; reason: string }): string {
  if (!['calm', 'investigate', 'gather'].includes(input.intent) || !['llm', 'player'].includes(input.source) || !input.reason.trim() || input.reason.length > 240) throw new Error('Invalid resident intervention');
  return decideWithTree(v, 'intervention', selector<World, string>('intervention', [
    branch('unavailable', w => !v.alive || (v.hiddenUntilTerm ?? -1) > w.term || !isAwake(v.activity, w.calendar.segment, w.config.segmentsPerDay), () => '今は応じられない。'),
    branch('existing-request', w => currentIntervention(w, v) !== null, () => '先に聞いた話を考えている。'),
    branch('isolation', () => v.townLife?.housing === 'isolated' && input.intent !== 'calm', () => '今は離れから出られない。'),
    branch('discipline', () => v.persona.traits.discipline > .75 && input.intent === 'gather', () => '今は自分の日課を優先したい。'),
    leaf('accept-intent', w => { v.btIntervention = { ...input, untilTick: w.term * w.config.segmentsPerDay + w.calendar.segment + 2 }; return input.intent === 'calm' ? '少し落ち着いて考える。' : input.intent === 'investigate' ? '広場で手掛かりを確かめよう。' : '仕事の合間に広場へ寄ってみる。'; }),
  ]), world, value => value);
}
