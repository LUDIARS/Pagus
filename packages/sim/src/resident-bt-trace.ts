import type { Villager } from './types/index.js';
import { runTree, type BtNode, type BtVisit } from './behavior-tree.js';

export interface ResidentBtTrace { phase: string; visits: BtVisit[]; decision: string }
export function decideWithTree<C, T>(resident: Villager, phase: string, tree: BtNode<C, T>, context: C, describe: (value: T) => string): T {
  const { value, visits } = runTree(tree, context);
  const trace = { phase, visits, decision: describe(value) };
  resident.btHistory = [...(resident.btHistory ?? []), trace].slice(-8);
  return value;
}
