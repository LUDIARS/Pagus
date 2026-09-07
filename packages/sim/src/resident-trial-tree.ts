import type { FateVoteContext, FoolishVoteContext, EducationContext } from './brain.js';
import type { Reform, Villager } from './types/index.js';
import { branch, leaf, selector } from './behavior-tree.js';
import { decideWithTree } from './resident-bt-trace.js';
import { educationHolds, educationPartsFor } from './education-profile.js';

/** Each voter chooses locally; the existing bloc contract aggregates those decisions. */
export function foolishTree(ctx: FoolishVoteContext): string {
  if (!ctx.candidates.length || !ctx.voters.length) throw new Error('Voting requires candidates and voters');
  const votes = ctx.voters.map(v => decideWithTree(v, 'foolish-vote', selector<FoolishVoteContext, string>('foolish-vote', [
    branch('known-account', c => c.candidates.some(candidate => v.information.some(info => info.text.includes(candidate.name) && info.source === 'observation')),
      c => c.candidates.find(candidate => v.information.some(info => info.text.includes(candidate.name) && info.source === 'observation'))!.id),
    leaf('weigh-conduct', c => [...c.candidates].sort((a,b) => suspicion(v,b) - suspicion(v,a) || a.id.localeCompare(b.id))[0]!.id),
  ]), ctx, id => `愚かだと考えた住民: ${id}`));
  return majority(votes);
}
function suspicion(voter: Villager, candidate: Villager): number {
  // No access to hidden culprit identity or mixed appearance. This is fallible opinion.
  return candidate.persona.traits.aggression * voter.persona.traits.discipline + candidate.persona.traits.ambition * (1 - voter.persona.traits.ambition) - candidate.persona.traits.kindness * voter.persona.traits.kindness - (candidate.id === voter.partnerId ? .4 : 0);
}
export function fateTree(ctx: FateVoteContext): 'kill' | 'spare' {
  if (!ctx.voters.length) throw new Error('Voting requires voters');
  const votes = ctx.voters.map(v => decideWithTree(v, 'fate-vote', selector<FateVoteContext, 'kill' | 'spare'>('fate-vote', [
    branch('education-empathy', () => educationPartsFor(v).includes('tentacles') && v.persona.traits.kindness > v.persona.traits.aggression, () => 'spare'),
    branch('uncertain-account', c => !!c.incident.story && v.persona.traits.curiosity > v.persona.traits.aggression, () => 'spare'),
    branch('punitive', c => c.incident.damage >= 6 && v.persona.traits.aggression + v.persona.traits.discipline > 1.2 + v.persona.traits.kindness * .5, () => 'kill'),
    leaf('prefer-reform', () => 'spare'),
  ]), ctx, pick => pick === 'kill' ? '厳しい処罰を求める' : '教育の機会を求める'));
  return votes.filter(v => v === 'kill').length > votes.length / 2 ? 'kill' : 'spare';
}
export function educationTree(ctx: EducationContext): Reform {
  const v = ctx.perpetrator;
  const reform = (direction: 'empathy' | 'discipline' | 'curiosity'): Reform => ({ kind: 'educate', villager: v.id, direction,
    rationale: direction === 'empathy' ? '他者の痛みに気付く習慣を身につける' : direction === 'discipline' ? '衝動より約束と日課を優先する' : '噂を確かめてから判断する',
    persona: { traits: direction === 'empathy' ? { kindness: .2, aggression: -.2 } : direction === 'discipline' ? { discipline: .2, aggression: -.1 } : { curiosity: .2, aggression: -.1 } } });
  return decideWithTree(v, 'education', selector<EducationContext, Reform>('education', [
    branch('harm-repair', () => v.persona.traits.aggression > v.persona.traits.kindness, () => reform('empathy')),
    branch('keep-promises', () => v.persona.traits.discipline < .55, () => reform('discipline')),
    leaf('verify-beliefs', () => reform('curiosity')),
  ]), ctx, value => value.rationale);
}
function majority(votes: string[]): string {
  const counts = new Map<string, number>();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  return [...counts].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

/** Even special culprit/madman pressure passes the education gate in BT mode. */
export function manipulationTree(v: Villager, term: number): boolean {
  return decideWithTree(v, 'trial-pressure', selector<Villager, boolean>('trial-pressure', [
    // Recency-bounded; a trait gate here would permanently disarm every educated
    // culprit and madman. See educationHolds.
    branch('education-gate', actor => {
      const parts = educationPartsFor(actor);
      return educationHolds(actor, term) && (parts.includes('tentacles') || parts.includes('clockwork'));
    }, () => false),
    branch('self-interest', actor => actor.madman || actor.persona.traits.ambition > actor.persona.traits.kindness, () => true),
    leaf('refrain', () => false),
  ]), v, value => value ? '投票へ圧力を加える' : '他人へ罪を押し付けない');
}
