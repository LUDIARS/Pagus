// 裁判バリエーション (§v1.4-B) — 毎回同型 (foolish→fate) の裁判に構成差を出す。
// witness: 目撃者が開廷時に証言し、foolish 票へ重みを乗せる (冤罪では framed へ乗り説得力を出す)。
// reveal: 冤罪被告が fate 段階に入った瞬間、確率で真犯人が発覚して被告が差し替わる逆転。
// どちらも LLM 非依存の決定的処理 (rng 注入)。

import type { World, Incident, TrialState, TrialWitness } from './types/index.js';
import { aliveVillagers } from './world.js';

/** 裁判バリエーションのチューニング値 (config arc.*)。 */
export interface TrialComposeConfig {
  /** 開廷時に立つ目撃者の最大数。 */
  witnessMax: number;
  /** 目撃者 1 人が foolish 票へ乗せる重み。 */
  witnessWeight: number;
  /** 冤罪被告の fate 段階で真犯人が発覚する確率。 */
  revealChance: number;
}

export const DEFAULT_TRIAL_COMPOSE: TrialComposeConfig = {
  witnessMax: 2,
  witnessWeight: 2,
  revealChance: 0.25,
};

const WITNESS_LINES = [
  'わたしは見た。{accused} がやったんだ！',
  '{accused} があの場にいたのを覚えている',
  'あの日の {accused} は様子がおかしかった…',
];

/**
 * 開廷時の目撃者を立てる (§v1.4-B witness)。事件の傍観者 (当事者以外) から最大 witnessMax 人を選び、
 * 「告発対象」へ foolish 票の重みを乗せる。連続犯の擦り付け (framedTargetId) があれば
 * 目撃者は framed を指す = 冤罪に説得力が生まれる。立てた目撃者を返す (0 人もある)。
 */
export function composeWitnesses(
  world: World,
  incident: Incident,
  trial: TrialState,
  rng: () => number,
  cfg: TrialComposeConfig = DEFAULT_TRIAL_COMPOSE,
): TrialWitness[] {
  const partyIds = new Set([incident.perpetrator, ...incident.involved]);
  const bystanders = aliveVillagers(world).filter((v) => !partyIds.has(v.id));
  if (bystanders.length === 0) return [];
  // 告発対象: 擦り付けがあれば framed (冤罪)、なければ加害者。候補に居なければ立たない。
  const accusedId = incident.framedTargetId ?? incident.perpetrator;
  if (!trial.candidates.includes(accusedId)) return [];
  const accusedName = world.villagers.get(accusedId)?.name ?? accusedId;

  const n = Math.min(cfg.witnessMax, bystanders.length);
  const witnesses: TrialWitness[] = [];
  const pool = [...bystanders];
  for (let i = 0; i < n; i += 1) {
    const idx = Math.floor(rng() * pool.length);
    const w = pool.splice(idx, 1)[0];
    if (!w) break;
    const template = WITNESS_LINES[Math.floor(rng() * WITNESS_LINES.length)] ?? WITNESS_LINES[0] ?? '';
    const account = incident.story?.evidence.filter((e) => e.stage === 'opening')[i % 2];
    const line = account ? `「${account.title}」にはこうある：${account.account}。これだけで断定はできない。` : template.replaceAll('{accused}', accusedName);
    witnesses.push({ id: w.id, name: w.name, accusedId, line });
  }
  for (const w of witnesses) {
    if (incident.story) continue; // Reading a disputed account must not manufacture an accusation vote.
    trial.foolishVotes[w.accusedId] = (trial.foolishVotes[w.accusedId] ?? 0) + cfg.witnessWeight;
    trial.votes.push({ voter: 'witness', weight: cfg.witnessWeight, pick: w.accusedId });
  }
  trial.witnesses = witnesses;
  return witnesses;
}

export interface RevealResult {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
}

/**
 * 真犯人の発覚 (§v1.4-B reveal)。被告が擦り付けられた無実の者 (framedTargetId) のとき、
 * fate 段階の開始時に確率で真犯人が発覚し、被告を真犯人へ差し替えて fate 票をリセットする。
 * 発覚しなければ null。二重発覚はしない (trial.reveal が既にあれば null)。
 */
export function maybeReveal(
  world: World,
  incident: Incident,
  trial: TrialState,
  rng: () => number,
  cfg: TrialComposeConfig = DEFAULT_TRIAL_COMPOSE,
): RevealResult | null {
  if (trial.reveal) return null;
  if (trial.stage !== 'fate' || trial.defendant === null) return null;
  const framed = incident.framedTargetId;
  if (!framed || trial.defendant !== framed) return null;
  const culprit = world.villagers.get(incident.perpetrator);
  if (!culprit || !culprit.alive) return null;
  if (rng() >= cfg.revealChance) return null;

  const fromName = world.villagers.get(framed)?.name ?? framed;
  const result: RevealResult = { fromId: framed, fromName, toId: culprit.id, toName: culprit.name };
  trial.defendant = culprit.id;
  trial.fateVotes = { kill: 0, spare: 0 };
  trial.reveal = { fromId: result.fromId, fromName: result.fromName, toId: result.toId, toName: result.toName };
  // 擦り付けは露見した → 以後この事件では冤罪票が働かないように消す。
  incident.framedTargetId = null;
  return result;
}
