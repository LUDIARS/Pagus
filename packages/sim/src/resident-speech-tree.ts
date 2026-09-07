import type { Villager, World } from './types/index.js';
import { branch, leaf, selector } from './behavior-tree.js';
import { decideWithTree } from './resident-bt-trace.js';
import { educationPartsFor } from './education-profile.js';

export function residentSpeech(v: Villager, world: World, topic: 'trial' | 'kill' | 'spare'): string {
  return decideWithTree(v, 'speech', selector<World, string>('speech', [
    branch('empathy-gate', () => topic === 'kill' && educationPartsFor(v).includes('tentacles') && v.persona.traits.kindness > v.persona.traits.aggression, () => 'その声は聞いた。でも命を奪う前に、やり直す道を考えたい。'),
    branch('examine-evidence', w => topic === 'trial' && !!w.incident?.story, w => `記録を照らし合わせたい。${w.incident!.story!.question}`),
    branch('cautious', () => v.persona.traits.curiosity >= v.persona.traits.aggression, () => '見聞きを確かめてから、自分で判断する。'),
    branch('mercy', () => topic === 'spare' || v.persona.traits.kindness > .6, () => '教育でやり直す機会を考えたい。'),
    leaf('accountability', () => '誰が何をしたのか、責任をはっきりさせたい。'),
  ]), world, value => value);
}
