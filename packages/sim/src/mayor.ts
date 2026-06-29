// 村長選挙エンジン (§17) — LLM 非依存の決定的アルゴリズム (ブラックボックスエンジン)。
//
// 村長は村人 (NPC) の 1 体。選挙イベントで村人世論 (人気度) により決まる。
//   - 選挙の半年前 (campaign) から、匿名世論調査 (支持率/人気候補/わからない・みんなきらい・
//     きょうみない) を半月ごとに更新して表示する。
//   - プレイヤーは村長にリコール請求でき、成功率は支持率と過去の事件で決まる。
//   - プレイヤーは推し/応援/扇動などで村人の感情・評判を動かし、間接的に世論へ影響する。

import type { World, Villager, VillagerId, MayorPoll } from './types/index.js';
import { aliveVillagers } from './world.js';
import { REACTION_EXPOSURE } from './daily-engine.js';

/** 選挙のチューニング値 (§17)。ターム基準 (1 ターム = ゲーム内 1 日)。 */
export interface MayorConfig {
  /** 選挙の周期 (ターム)。既定 360 ≈ ゲーム内 1 年。 */
  electionIntervalTerms: number;
  /** 選挙運動 (世論調査表示) を始める選挙前ターム数。既定 180 ≈ 半年。 */
  campaignTerms: number;
  /** 世論調査の更新間隔 (ターム)。既定 15 ≈ 半月 (≈30分)。 */
  pollRefreshTerms: number;
  /** 人気候補として出す上位数。 */
  topCandidates: number;
  /** 「みんなきらい」に倒れる攻撃性+怒りの閾値。 */
  hateThreshold: number;
  /** 「きょうみない」に倒れる社交性+好奇心の閾値 (これ未満)。 */
  interestThreshold: number;
  /** 「わからない」に倒れる規律の閾値 (これ未満)。 */
  clarityThreshold: number;
  /** リコール成功率: 低支持率の重み。 */
  recallApprovalWeight: number;
  /** リコール成功率: 過去の事件の重み。 */
  recallIncidentWeight: number;
  /** 過去の事件カウントをこの値で割って 0..1 に正規化。 */
  recallIncidentScale: number;
  /** リコール成功率の上限 (確実成立を避ける)。 */
  recallMaxProb: number;
}

export const DEFAULT_MAYOR: MayorConfig = {
  electionIntervalTerms: 360,
  campaignTerms: 180,
  pollRefreshTerms: 15,
  topCandidates: 3,
  hateThreshold: 1.1,
  interestThreshold: 0.6,
  clarityThreshold: 0.35,
  recallApprovalWeight: 0.7,
  recallIncidentWeight: 0.5,
  recallIncidentScale: 4,
  recallMaxProb: 0.9,
};

/**
 * 村人の村長としての人気度 (0..1, §17)。穏やか・社交的・勤勉・有志を好み、攻撃的・狂人・クズを嫌う。
 * 感情 (喜び/怒り) も反映。プレイヤーの応援/扇動はこれらの感情・気質を通じて間接的に効く。
 */
export function popularity(v: Villager): number {
  const t = v.persona.traits;
  const joy = v.emotion.axes['joy'] ?? 0;
  const anger = v.emotion.axes['anger'] ?? 0;
  let p =
    0.45 +
    t.kindness * 0.2 +
    t.sociability * 0.15 +
    t.discipline * 0.1 +
    t.ambition * 0.08 -
    t.aggression * 0.15 +
    joy * 0.1 -
    anger * 0.12;
  if (v.madman) p -= 0.4;
  if (v.scummy) p -= 0.2;
  return Math.min(1, Math.max(0, p));
}

/** 人気度が最も高い生存村人を返す (除外 id を避ける)。同値は villager id 昇順で先勝ち。 */
function topVillager(alive: Villager[], excludeId?: VillagerId): Villager | null {
  let best: Villager | null = null;
  let bestPop = -1;
  for (const v of [...alive].sort((a, b) => a.id.localeCompare(b.id))) {
    if (excludeId && v.id === excludeId) continue;
    const p = popularity(v);
    if (p > bestPop) {
      bestPop = p;
      best = v;
    }
  }
  return best;
}

/**
 * 匿名世論調査を計算する (§17, 純関数)。生存村人を有権者として、各自を
 * みんなきらい / きょうみない / わからない / 支持 に振り分け、人気候補と現村長支持率を出す。
 */
export function computeMayorPoll(world: World, cfg: MayorConfig = DEFAULT_MAYOR): MayorPoll {
  const alive = aliveVillagers(world);
  const n = alive.length;
  if (n === 0) return { approval: 0, candidates: [], dontKnow: 0, hate: 0, noInterest: 0 };

  let hate = 0;
  let noInterest = 0;
  let dontKnow = 0;
  for (const voter of alive) {
    const t = voter.persona.traits;
    const anger = voter.emotion.axes['anger'] ?? 0;
    if (t.aggression + anger > cfg.hateThreshold) hate += 1;
    else if (t.sociability + t.curiosity < cfg.interestThreshold) noInterest += 1;
    else if (t.discipline < cfg.clarityThreshold) dontKnow += 1;
    // それ以外は「支持層」(候補へ票が向く)。
  }

  const ranked = [...alive].sort((a, b) => popularity(b) - popularity(a) || a.id.localeCompare(b.id));
  const candidates = ranked
    .slice(0, cfg.topCandidates)
    .map((v) => ({ id: v.id, name: v.name, support: popularity(v) }));

  // 支持率 = 現村長の人気度を、村全体の険悪さ (みんなきらい率) で割り引いた値。
  const mayor = world.mayorId ? world.villagers.get(world.mayorId) : null;
  const approval = mayor && mayor.alive ? clamp01(popularity(mayor) * (1 - hate / n)) : 0;

  return { approval, candidates, dontKnow: dontKnow / n, hate: hate / n, noInterest: noInterest / n };
}

/** リコール成功確率 (§17)。低支持率 + 過去の事件 (反逆/改変回数) で上がる。 */
export function recallProbability(world: World, cfg: MayorConfig = DEFAULT_MAYOR): number {
  const mayor = world.mayorId ? world.villagers.get(world.mayorId) : null;
  if (!mayor || !mayor.alive) return 0;
  const approval = computeMayorPoll(world, cfg).approval;
  const incidents = (mayor.eventParams[REACTION_EXPOSURE] ?? 0) + mayor.reformCount;
  const incidentFactor = Math.min(1, incidents / cfg.recallIncidentScale);
  const prob = (1 - approval) * cfg.recallApprovalWeight + incidentFactor * cfg.recallIncidentWeight;
  return Math.min(cfg.recallMaxProb, Math.max(0, prob));
}

/** 選挙イベントの結果 (server がログ/歴史に使う)。 */
export interface MayorEvent {
  kind: 'elected' | 'vacancy-elected';
  name: string;
}

/** 選挙を行い、人気度最大の村人を村長にする。除外 id を避ける。当選者名を返す (候補なしは null)。 */
export function electMayor(world: World, cfg: MayorConfig = DEFAULT_MAYOR, excludeId?: VillagerId): string | null {
  const winner = topVillager(aliveVillagers(world), excludeId);
  world.mayorId = winner ? winner.id : null;
  world.mayorTermsLeft = cfg.electionIntervalTerms;
  world.mayorPoll = null;
  return winner ? winner.name : null;
}

/**
 * 日末の村長進行 (§17)。TermMachine が advanceDay で呼ぶ。
 *   - 村長が退場 (死亡/追放) していたら即時に補欠選挙。
 *   - 残ターム 0 で通常選挙。
 *   - 選挙運動期間 (残り <= campaignTerms) は pollRefreshTerms ごとに世論調査を更新。
 * 起きたイベントを返す (server がログ)。
 */
export function tickMayor(world: World, cfg: MayorConfig = DEFAULT_MAYOR): MayorEvent | null {
  const mayorAlive = world.mayorId !== null && (world.villagers.get(world.mayorId)?.alive ?? false);

  // 村長不在 (初期/死亡/追放) → 補欠選挙。
  if (!mayorAlive) {
    const name = electMayor(world, cfg);
    return name ? { kind: 'vacancy-elected', name } : null;
  }

  world.mayorTermsLeft -= 1;
  if (world.mayorTermsLeft <= 0) {
    const name = electMayor(world, cfg);
    return name ? { kind: 'elected', name } : null;
  }

  // 選挙運動期間: 世論調査を半月ごとに更新する。期間外は隠す。
  if (world.mayorTermsLeft <= cfg.campaignTerms) {
    const sinceCampaignStart = cfg.campaignTerms - world.mayorTermsLeft;
    if (sinceCampaignStart % cfg.pollRefreshTerms === 0) {
      world.mayorPoll = computeMayorPoll(world, cfg);
    }
  } else {
    world.mayorPoll = null;
  }
  return null;
}

/** リコール結果 (§17)。 */
export interface RecallResult {
  /** 村長がいた (請求が成立し判定した) か。 */
  attempted: boolean;
  success: boolean;
  probability: number;
  /** 罷免された村長名 (success 時)。 */
  ousted?: string;
  /** 補欠当選した新村長名 (success 時)。 */
  newMayor?: string;
}

/**
 * 村長リコールを判定する (§17)。rng < 成功確率 で成立 → 罷免し、罷免者を除いて即補欠選挙。
 * 村長不在なら attempted=false。
 */
export function recallMayor(world: World, rng: () => number, cfg: MayorConfig = DEFAULT_MAYOR): RecallResult {
  const mayor = world.mayorId ? world.villagers.get(world.mayorId) : null;
  if (!mayor || !mayor.alive) return { attempted: false, success: false, probability: 0 };
  const probability = recallProbability(world, cfg);
  if (rng() >= probability) return { attempted: true, success: false, probability };
  const ousted = mayor.name;
  const newMayor = electMayor(world, cfg, mayor.id); // 罷免者を除いて補欠
  const result: RecallResult = { attempted: true, success: true, probability, ousted };
  if (newMayor !== null) result.newMayor = newMayor;
  return result;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
