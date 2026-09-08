import type { World, TrialState, Incident, Reform, Villager } from './types/index.js';
import { branch, leaf, selector } from './behavior-tree.js';
import { decideWithTree } from './resident-bt-trace.js';
import { educationHolds } from './education-profile.js';

export type TrialSide = 'accusers' | 'defenders';
/** 各勢力の定員 (§ 勢力裁判)。法廷の描画席数もこの値に揃える。 */
export const FACTION_SIDE_LIMIT = 10;
export interface FactionTrial {
  accusers: string[];
  defenders: string[];
  scores: Record<TrialSide, number>;
  turn: number;
  lines: { speaker: string; side: TrialSide; text: string }[];
  loser: TrialSide | null;
  explanation: string;
  sanctions?: Reform[];
  applied?: string[];
}

/** Public cast and relationships decide sides, never secret culprit knowledge. */
export function createFactionTrial(world: World, incident: Incident, accusedId: string): FactionTrial | undefined {
  const residents = [...world.villagers.values()].filter(v => v.alive && (v.hiddenUntilTerm ?? -1) <= world.term);
  const accused = residents.find(v => v.id === accusedId);
  const opponent = residents.find(v => v.id !== accusedId && incident.involved.includes(v.id))
    ?? residents.find(v => v.id !== accusedId);
  if (!accused || !opponent) return undefined; // A single resident cannot form two sides.
  const state: FactionTrial = { accusers: [opponent.id], defenders: [accused.id], scores: { accusers: 0, defenders: 0 }, turn: 0, lines: [], loser: null, explanation: '' };
  const affinity = (v: Villager, target: string): number => world.relationships.filter(r => r.from === v.id && r.to === target).reduce((sum, r) => sum + r.affinity, 0);
  for (const v of residents.sort((a, b) => a.id.localeCompare(b.id))) {
    if (v.id === accused.id || v.id === opponent.id) continue;
    const side: TrialSide = affinity(v, accused.id) > affinity(v, opponent.id) ? 'defenders' : 'accusers';
    const other = side === 'accusers' ? 'defenders' : 'accusers';
    if (state[side].length < FACTION_SIDE_LIMIT) state[side].push(v.id);
    else if (state[other].length < FACTION_SIDE_LIMIT) state[other].push(v.id);
    if (state.accusers.length === FACTION_SIDE_LIMIT && state.defenders.length === FACTION_SIDE_LIMIT) break;
  }
  return state;
}

/** One BT argument per step; two rounds before the collective side verdict. */
export function advanceFactionDebate(world: World, trial: TrialState): boolean {
  const f = trial.factions;
  if (!f || f.loser) return true;
  const order = Array.from({ length: Math.max(f.accusers.length, f.defenders.length) }, (_, i) => [
    { side: 'accusers' as const, id: f.accusers[i] }, { side: 'defenders' as const, id: f.defenders[i] },
  ]).flat().filter((entry): entry is { side: TrialSide; id: string } => !!entry.id);
  if (order.length === 0) return true; // 参加者が全滅していれば討論は打ち切る。
  if (f.turn >= order.length * 2) return true; // 2 巡ぶんは発言済み。
  const entry = order[f.turn % order.length];
  if (!entry) throw new Error('Faction debate requires participants');
  const actor = world.villagers.get(entry.id);
  if (actor?.alive) {
    const witnessed = trial.witnesses?.some(w => w.id === actor.id) ?? false;
    const argument = decideWithTree(actor, 'faction-debate', selector<Villager, { text: string; points: number }>('faction-debate', [
      branch('education-restraint', v => educationHolds(v, world.term), () => ({ text: '怒鳴るな！証言を最後まで聞け。決めつけで人を潰す気か！', points: 2 })),
      branch('witness-account', () => witnessed, () => ({ text: '見たことまで嘘扱いか！都合の悪い話から逃げるな！', points: 4 })),
      branch('cross-examination', v => v.persona.traits.curiosity + v.persona.traits.discipline > 1.1, () => ({ text: 'さっきの話と食い違っているぞ。大声でごまかすな！', points: 3 })),
      branch('angry-smear', v => v.persona.traits.aggression > .6, () => ({ text: '卑怯者！自分たちだけ助かればいいんだろう！', points: 1 })),
      leaf('defend-standing', () => ({ text: 'その言い方は何だ！こちらの暮らしを踏みにじるな！', points: 2 })),
    ]), actor, value => value.text);
    f.scores[entry.side] += argument.points;
    f.lines.push({ speaker: actor.id, side: entry.side, text: argument.text });
  }
  f.turn++;
  return f.turn >= order.length * 2;
}

/**
 * 敗北勢力を確定する。被告は既存の foolish 票 (§12.3.3 の擦り付け/扇動を含む) が決めるので、
 * その被告が属する側を敗北勢力とし、議論の説得点は理由文にだけ使う。
 */
export function settleFactionSides(trial: TrialState, defendant: string | null): void {
  const f = trial.factions;
  if (!f || f.loser) return;
  // Compare per-capita persuasion, so a smaller side is not doomed by headcount.
  const accusation = f.scores.accusers / Math.max(1, f.accusers.length);
  const defense = f.scores.defenders / Math.max(1, f.defenders.length);
  // 被告が決まっていればその所属側が敗北 (票が勝敗の正本)。決まっていなければ説得点で決める。
  const byDefendant = defendant && f.accusers.includes(defendant)
    ? 'accusers' as const
    : defendant && f.defenders.includes(defendant)
      ? 'defenders' as const
      : null;
  f.loser = byDefendant ?? (accusation > defense ? 'defenders' : 'accusers');
  const sideName = f.loser === 'accusers' ? '告発側' : '被告側';
  f.explanation = byDefendant
    ? `被告を出した${sideName}が敗北勢力となった。`
    : accusation === defense
      ? '議論は拮抗。立証できなかった告発側が敗北。'
      : `${sideName}は証言と反論で押し負けた。`;
  if (defendant && !f[f.loser].includes(defendant)) f[f.loser].push(defendant);
}
