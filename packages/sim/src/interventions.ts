// 即効介入 (v1.4-A §3) — 野次 (heckle) / 証言 (testify) / 差し入れ・毒饅頭 (gift)。
// LLM 非依存の決定的処理。プレイヤー介入は「3 秒で見えるリアクション + 残留タグ」の
// 2 点セットを必須とする (§3.2): ここは即時効果と残留タグ (eventParams / testimonies) を担い、
// 見えるリアクション (吹き出し/live feed) は server/client が返す。

import type { World, Villager, VillagerId, Incident, TrialState, TestimonyRecord, FieldItemKind, SpotMode, InfoItem } from './types/index.js';
import { bumpEventParam, aliveVillagers, placeAt, PLACES, NEARBY_RADIUS } from './world.js';
import { groupByDominant } from './personality.js';
import { applyItemEffect, type ItemConfig, DEFAULT_ITEMS } from './items.js';
import { REACTION_EXPOSURE } from './daily-engine.js';

/** 即効介入のチューニング値 (§3.3)。数値は当て推量で観戦調整前提 (config intervene.*)。 */
export interface InterventionConfig {
  /** 野次 (agitate) 1 回の被害加算。閾値超えで裁判が早まる。 */
  heckleDamage: number;
  /** 野次 1 回が動かす和解バイアス量 (agitate で減・soothe で増)。 */
  heckleBias: number;
  /** 差し入れ (treat) の所持金増。 */
  giftTreatWealth: number;
  /** 差し入れ (treat) の喜び増 (-1..1 クランプ)。 */
  giftTreatJoy: number;
  /** 場所を荒らした瞬間、その場の住民に走る怒り (§v1.4-A' spot)。 */
  spotAnger: number;
  /** 場所を清めた瞬間、その場の住民に広がる喜び (§v1.4-A' spot)。 */
  spotJoy: number;
}

export const DEFAULT_INTERVENTION: InterventionConfig = {
  heckleDamage: 1,
  heckleBias: 0.08,
  giftTreatWealth: 25,
  giftTreatJoy: 0.2,
  spotAnger: 0.15,
  spotJoy: 0.15,
};

/** 野次られた当事者に残る残留タグ (§3.2 の 2 点セット)。behavior-rules の発火条件素材。 */
export const HECKLED_TAG = 'heckled';
/** 有罪証言を投げられた被告に残る残留タグ。v1.4-B の遺恨 (grudge) thread の生成点になる。 */
export const TESTIFIED_TAG = 'testifiedAgainst';

/** 野次の向き。agitate=煽る (被害増・和解しにくく) / soothe=なだめる (和解しやすく)。 */
export type HeckleSide = 'agitate' | 'soothe';

export interface HeckleResult {
  /** 加害者名 (live feed 表示用)。 */
  perpetratorName: string;
  /** 野次後の累計被害。 */
  damage: number;
  /** 呼び出し側 (TermMachine) が reconcileBias へ足すバイアス差分。 */
  biasDelta: number;
}

/**
 * 野次 (§3.3): 進行中の事件の当事者たちへ観客の声を浴びせる。
 * agitate は被害を即加算 (次の shoStep の閾値判定で裁判が早まる)、soothe は和解バイアスを上げる。
 * どちらも当事者へ HECKLED_TAG を残す (野次られた記憶は気を立たせる火種になる)。
 * バイアスの実適用は reconcileBias を持つ TermMachine が行う (戻り値 biasDelta)。
 */
export function heckleIncident(
  world: World,
  incident: Incident,
  side: HeckleSide,
  cfg: InterventionConfig = DEFAULT_INTERVENTION,
): HeckleResult {
  if (side === 'agitate') incident.damage += cfg.heckleDamage;
  for (const id of [incident.perpetrator, ...incident.involved]) {
    const v = world.villagers.get(id);
    if (v) bumpEventParam(v, HECKLED_TAG, 1);
  }
  const perpetratorName = world.villagers.get(incident.perpetrator)?.name ?? incident.perpetrator;
  return {
    perpetratorName,
    damage: incident.damage,
    biasDelta: side === 'agitate' ? -cfg.heckleBias : cfg.heckleBias,
  };
}

/** 証言 1 グループ分の重み = 生存住民数 ÷ グループ数 (切り上げ、最低 1)。 */
export function testimonyWeight(world: World): number {
  const alive = aliveVillagers(world);
  const groups = groupByDominant(alive, (v) => v.persona.traits).size;
  if (groups === 0) return 1;
  return Math.max(1, Math.ceil(alive.length / groups));
}

export type TestifyOutcome =
  | { ok: true; record: TestimonyRecord; defendantName: string }
  | { ok: false; reason: string };

/**
 * 証言の投げ込み (§3.3): 裁判の運命 (fate) 段階に、1 グループ分の重みで票を上乗せする。
 * accuse=死刑側 / defend=教育側。1 ユーザ 1 裁判 1 回。有罪証言は被告へ TESTIFIED_TAG を残し
 * (冤罪なら v1.4-B の遺恨 thread の火種)、証言記録は trial.testimonies に積む。
 */
export function testifyInTrial(
  world: World,
  trial: TrialState,
  userId: string,
  stance: 'accuse' | 'defend',
  text?: string,
): TestifyOutcome {
  if (trial.stage !== 'fate') return { ok: false, reason: '証言は運命 (fate) 段階のみ' };
  if (trial.defendant === null) return { ok: false, reason: '被告が未確定' };
  const testimonies = trial.testimonies ?? (trial.testimonies = []);
  if (testimonies.some((t) => t.userId === userId)) {
    return { ok: false, reason: 'この裁判ではすでに証言済み' };
  }
  const defendant = world.villagers.get(trial.defendant);
  if (!defendant) return { ok: false, reason: '被告が見つからない' };

  const weight = testimonyWeight(world);
  const pick = stance === 'accuse' ? 'kill' : 'spare';
  if (stance === 'accuse') trial.fateVotes.kill += weight;
  else trial.fateVotes.spare += weight;

  const record: TestimonyRecord = { userId, stance, weight };
  const trimmed = text?.trim();
  if (trimmed) record.text = trimmed.slice(0, 30);
  testimonies.push(record);
  trial.votes.push({ voter: 'testimony', weight, pick, userId });

  if (stance === 'accuse') {
    // 残留タグ: 有罪を訴えられた記憶は被告を気を立たせ (§12.6)、B の遺恨 thread の生成点になる。
    bumpEventParam(defendant, TESTIFIED_TAG, 1);
  }
  return { ok: true, record, defendantName: defendant.name };
}

/** 感情軸を -1..1 にクランプして加算する。 */
function nudgeEmotion(v: Villager, axis: string, delta: number): void {
  const next = (v.emotion.axes[axis] ?? 0) + delta;
  v.emotion.axes[axis] = Math.min(1, Math.max(-1, next));
}

export interface SpotResult {
  place: string;
  state: SpotMode;
  /** 即時に感情が動いた (その場にいた) 住民の数。 */
  affected: number;
  untilTerm: number;
}

/**
 * 場所を荒らす/清める (§v1.4-A' spot)。その場にいる住民全員の感情が即時に動き、
 * PlaceStateEntry が days ターム残って behavior-rule (base_defiled_place 等) に効く =
 * 環境そのものへの介入 (三分の「環境=プログラム」に整合)。place が不正なら null。
 */
export function setPlaceState(
  world: World,
  place: string,
  mode: 'defile' | 'bless',
  days: number,
  cfg: InterventionConfig = DEFAULT_INTERVENTION,
): SpotResult | null {
  if (!(PLACES as readonly string[]).includes(place)) return null;
  const state: SpotMode = mode === 'defile' ? 'defiled' : 'blessed';
  const untilTerm = world.term + Math.max(1, Math.floor(days));
  // 同じ場所の既存 entry は上書き (荒らし⇄清めの塗り替え可)。
  world.placeStates = world.placeStates.filter((e) => e.place !== place);
  world.placeStates.push({ place, state, untilTerm });
  let affected = 0;
  for (const v of aliveVillagers(world)) {
    if (placeAt(world, v.position) !== place) continue;
    if (state === 'defiled') nudgeEmotion(v, 'anger', cfg.spotAnger);
    else nudgeEmotion(v, 'joy', cfg.spotJoy);
    affected += 1;
  }
  return { place, state, affected, untilTerm };
}

/** 失効した場所の状態 (untilTerm <= term) を除去して返す (日末の掃除)。 */
export function pruneExpiredPlaceStates(world: World): SpotResult[] {
  const removed: SpotResult[] = [];
  world.placeStates = world.placeStates.filter((e) => {
    if (e.untilTerm > world.term) return true;
    removed.push({ place: e.place, state: e.state, affected: 0, untilTerm: e.untilTerm });
    return false;
  });
  return removed;
}

export interface FanFlamesResult {
  targetName: string;
  /** 広めた噂の本文。 */
  rumorText: string;
  /** 噂が届いた近傍住民の数。 */
  spreadCount: number;
}

/**
 * 噂の増幅 (§v1.4-A' fanFlames)。対象が抱えるプレイヤー由来の噂 (扇動 §4.2 / 偽予言で注入した
 * source:'player' の InfoItem) のうち最新の 1 件を、対象の近傍住民へ複製して撒く。
 * 受け取った住民は REACTION_EXPOSURE が積まれ翌日以降のアルゴリズムイベントが増える。
 * 対象が不在/退場、または広める噂を持っていなければ null。
 */
export function fanFlames(world: World, targetId: VillagerId): FanFlamesResult | null {
  const target = world.villagers.get(targetId);
  if (!target || !target.alive) return null;
  const rumor = [...target.information].reverse().find((i) => i.source === 'player');
  if (!rumor) return null;
  const neighbors = aliveVillagers(world).filter(
    (v) =>
      v.id !== targetId &&
      Math.max(Math.abs(v.position.x - target.position.x), Math.abs(v.position.y - target.position.y)) <= NEARBY_RADIUS,
  );
  let n = 0;
  for (const v of neighbors) {
    // 同じ噂の重複配布はしない (id 接頭辞で判定)。
    if (v.information.some((i) => i.id.startsWith(`${rumor.id}_spread_`))) continue;
    const copy: InfoItem = {
      id: `${rumor.id}_spread_${v.id}`,
      text: `噂で聞いた: ${rumor.text}`,
      source: 'player',
      termAcquired: world.term,
    };
    v.information.push(copy);
    bumpEventParam(v, REACTION_EXPOSURE, 1);
    n += 1;
  }
  return { targetName: target.name, rumorText: rumor.text, spreadCount: n };
}

/** 贈り物の種別。treat=差し入れ (喜び+富) / poison=毒饅頭 (薬物と同じ荒れ方)。 */
export type GiftKind = 'treat' | 'poison';

export interface GiftResult {
  villagerName: string;
  kind: GiftKind;
}

/**
 * 贈り物の手渡し (§3.3): フィールド配置 (§16) と違い対象へ即適用する。
 * treat は喜びと所持金を上げる。poison は薬物と同じ効果 (怒り+・所持金−・drug タグ) で、
 * behavior-rule base_drugged に接続して数日荒れる。対象が不在/退場なら null。
 */
export function giveGift(
  world: World,
  targetId: VillagerId,
  kind: GiftKind,
  cfg: InterventionConfig = DEFAULT_INTERVENTION,
  itemCfg: ItemConfig = DEFAULT_ITEMS,
): GiftResult | null {
  const v = world.villagers.get(targetId);
  if (!v || !v.alive) return null;
  if (kind === 'treat') {
    v.wealth += cfg.giftTreatWealth;
    const joy = (v.emotion.axes['joy'] ?? 0) + cfg.giftTreatJoy;
    v.emotion.axes['joy'] = Math.min(1, Math.max(-1, joy));
  } else {
    applyItemEffect(v, 'drug' satisfies FieldItemKind, itemCfg);
  }
  return { villagerName: v.name, kind };
}
