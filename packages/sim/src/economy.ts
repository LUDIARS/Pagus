// 住民経済エンジン (§15) — LLM を一切呼ばない決定的アルゴリズム (ブラックボックスエンジン)。
//
// 住民は所持金 (Villager.wealth) を持ち、貧富の差がある。日末に一度、各住民が
//   ① 収入 (規律が高いほど多い) ② 趣味嗜好に従った消費 ③ 推しへの送金
// を行う。所持金が乏しい個体は非行 (事件化) に走りやすく (daily-engine 側の triggerWeight)、
// 大金を持つ個体は「クズ化」して消費が荒くなり・プレイヤーにお金を要求 (たかり) する。
//
// 本モジュールは純粋な数値アルゴリズム。感情/事件化への波及は behavior-rules の
// wealthBelow/wealthAbove ルール経由で daily-engine が拾う (関心の分離)。

import type { Villager, VillagerId, Hobby } from './types/index.js';
import { dominantAxis, type Personality } from './personality.js';

/** 経済のチューニング値 (§15)。sim 内定数。base ルールの閾値とも一致させる。 */
export interface EconomyConfig {
  /** 初期所持金の下駄。 */
  startBase: number;
  /** 初期所持金の振れ幅 (id ハッシュ 0..1 に掛ける)。貧富の差の主因。 */
  startSpread: number;
  /** 野心が初期所持金を押し上げる係数 (野心家ほど富む)。 */
  startAmbitionBonus: number;
  /** 日次の基礎収入。 */
  dailyIncome: number;
  /** 規律による日次収入の上乗せ係数 (勤勉ほど稼ぐ)。 */
  incomeDisciplineBonus: number;
  /** 趣味消費の基礎額 (hobby 倍率を掛ける)。 */
  consumeBase: number;
  /** クズ化個体の消費倍率 (消費が荒くなる)。 */
  scumWasteMult: number;
  /** これ未満は貧困 = 非行傾向 (behavior-rules と一致)。 */
  poorThreshold: number;
  /** これ以上で富裕。 */
  richThreshold: number;
  /** これ以上が続くとクズ化 (behavior-rules と一致)。 */
  scumThreshold: number;
  /** 推しへ送金する最低所持金 (これ以下は送らない)。 */
  sendFloor: number;
  /** 推しへ送金する確率 (0..1)。 */
  sendChance: number;
  /** 送金額 = (wealth - sendFloor) × この割合 (端数切り捨て)。 */
  sendPortion: number;
  /** クズ化個体がプレイヤーにたかる確率 (0..1)。 */
  demandChance: number;
  /** たかりの基礎額。 */
  demandBase: number;
  /** たかりの振れ幅 (rng を掛けて加算)。 */
  demandSpread: number;
}

/** 既定の経済設定 (§15)。閾値は behavior-rules の wealth ルールと一致させること。 */
export const DEFAULT_ECONOMY: EconomyConfig = {
  startBase: 30,
  startSpread: 220,
  startAmbitionBonus: 150,
  dailyIncome: 8,
  incomeDisciplineBonus: 8,
  consumeBase: 10,
  scumWasteMult: 2,
  poorThreshold: 40,
  richThreshold: 250,
  scumThreshold: 400,
  sendFloor: 60,
  sendChance: 0.35,
  sendPortion: 0.15,
  demandChance: 0.3,
  demandBase: 20,
  demandSpread: 30,
};

/** 趣味嗜好ごとの消費倍率 (consumeBase に掛ける)。質素は安く、賭博/美食は荒い。 */
const HOBBY_CONSUME_MULT: Record<Hobby, number> = {
  ascetic: 0.4,
  collector: 1.0,
  social: 1.0,
  fashion: 1.6,
  gourmet: 1.8,
  gamble: 2.2,
};

/** 趣味嗜好の日本語ラベル (ログ/UI 用)。 */
export const HOBBY_LABELS: Record<Hobby, string> = {
  ascetic: '質素',
  collector: '蒐集',
  social: '社交',
  fashion: '着飾り',
  gourmet: '美食',
  gamble: '賭博',
};

/** 趣味消費のログ動詞 (flavor)。 */
const HOBBY_VERB: Record<Hobby, string> = {
  ascetic: 'つましく暮らした',
  collector: 'コレクションを買い足した',
  social: '仲間に振る舞った',
  fashion: '装いに散財した',
  gourmet: '美食に散財した',
  gamble: '賭場で散財した',
};

/** 富の段階。 */
export type WealthTier = 'poor' | 'normal' | 'rich';

/** 所持金から富の段階を出す。 */
export function wealthTier(wealth: number, cfg: EconomyConfig = DEFAULT_ECONOMY): WealthTier {
  if (wealth < cfg.poorThreshold) return 'poor';
  if (wealth >= cfg.richThreshold) return 'rich';
  return 'normal';
}

/** id を 0..1 の決定的ハッシュにする (初期所持金の分散用、rng 不要で再現可能)。 */
function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 符号なし化して 0..1 へ。
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * 初期所持金 (§15)。id ハッシュ × 振れ幅 + 野心ボーナス + 下駄。決定的なので貧富の差を再現可能に作る。
 */
export function initialWealth(id: string, traits: Personality, cfg: EconomyConfig = DEFAULT_ECONOMY): number {
  const base = cfg.startBase + hash01(id) * cfg.startSpread + (traits.ambition ?? 0) * cfg.startAmbitionBonus;
  return Math.round(base);
}

/** dominant 気質から趣味嗜好を割り当てる (§15、決定的)。 */
export function pickHobby(traits: Personality): Hobby {
  switch (dominantAxis(traits)) {
    case 'kindness':
      return 'social';
    case 'aggression':
      return 'gamble';
    case 'sociability':
      return 'fashion';
    case 'curiosity':
      return 'collector';
    case 'discipline':
      return 'ascetic';
    case 'ambition':
      return 'gourmet';
  }
}

/** 日末経済決済の 1 件の出来事 (server がログ/たかり表示に使う)。 */
export interface EconomyTransfer {
  fromId: VillagerId;
  fromName: string;
  toId: VillagerId;
  toName: string;
  amount: number;
}
export interface EconomyDemand {
  villagerId: VillagerId;
  name: string;
  amount: number;
}
export interface ScumChange {
  villagerId: VillagerId;
  name: string;
  /** true = クズ化した / false = 更生した。 */
  scummy: boolean;
}

/** 日末経済決済の結果 (notable な出来事のみ。毎日の消費は集計しない)。 */
export interface EconomySettlement {
  /** 推しへの送金。 */
  transfers: EconomyTransfer[];
  /** クズ化個体のプレイヤーへのたかり。 */
  demands: EconomyDemand[];
  /** クズ化/更生の遷移。 */
  scumChanges: ScumChange[];
}

/**
 * 日末の住民経済を 1 回決済する (§15)。TermMachine が advanceDay 前後に呼ぶ。
 * 生存住民それぞれに 収入 → 趣味消費 → 推し送金 を適用し、クズ化判定と たかり を行う。
 * world.villagers (Map) を直接変異し、notable な出来事を返す。
 */
export function settleEconomy(
  villagers: Iterable<Villager>,
  rng: () => number,
  cfg: EconomyConfig = DEFAULT_ECONOMY,
): EconomySettlement {
  const all = [...villagers];
  const alive = all.filter((v) => v.alive);
  const byId = new Map(all.map((v) => [v.id, v]));
  const out: EconomySettlement = { transfers: [], demands: [], scumChanges: [] };

  for (const v of alive) {
    // ① 収入: 規律が高いほど多い。
    v.wealth += cfg.dailyIncome + (v.persona.traits.discipline ?? 0) * cfg.incomeDisciplineBonus;

    // ② 趣味消費: hobby 倍率 × (クズ化なら荒い)。所持金は 0 未満にしない。
    const waste = v.scummy ? cfg.scumWasteMult : 1;
    const consume = cfg.consumeBase * HOBBY_CONSUME_MULT[v.hobby] * waste;
    v.wealth = Math.max(0, v.wealth - consume);

    // ③ 推しへの送金: 推しが未設定/退場なら選び直す。
    if (!v.admireId || !(byId.get(v.admireId)?.alive ?? false)) {
      v.admireId = pickAdmire(v, alive, rng);
    }
    if (v.admireId && v.wealth > cfg.sendFloor && rng() < cfg.sendChance) {
      const target = byId.get(v.admireId);
      if (target && target.alive && target.id !== v.id) {
        const amount = Math.floor((v.wealth - cfg.sendFloor) * cfg.sendPortion);
        if (amount > 0) {
          v.wealth -= amount;
          target.wealth += amount;
          out.transfers.push({ fromId: v.id, fromName: v.name, toId: target.id, toName: target.name, amount });
        }
      }
    }

    // クズ化判定: 大金で true、富裕線を割れば更生。遷移のみ記録。
    const nowScummy = v.wealth >= cfg.scumThreshold;
    const wasRecovered = v.wealth < cfg.richThreshold;
    if (nowScummy && !v.scummy) {
      v.scummy = true;
      out.scumChanges.push({ villagerId: v.id, name: v.name, scummy: true });
    } else if (wasRecovered && v.scummy) {
      v.scummy = false;
      out.scumChanges.push({ villagerId: v.id, name: v.name, scummy: false });
    }

    // ④ クズ化個体はプレイヤーにたかる。
    if (v.scummy && rng() < cfg.demandChance) {
      const amount = Math.round(cfg.demandBase + rng() * cfg.demandSpread);
      out.demands.push({ villagerId: v.id, name: v.name, amount });
    }
  }
  return out;
}

/** 推しを選ぶ: 自分以外の生存住民から、最も野心の高い個体 (同値は rng でばらす)。 */
function pickAdmire(self: Villager, alive: Villager[], rng: () => number): VillagerId | null {
  const others = alive.filter((v) => v.id !== self.id);
  let best = others[0];
  if (!best) return null;
  for (const v of others) {
    const a = v.persona.traits.ambition ?? 0;
    const b = best.persona.traits.ambition ?? 0;
    if (a > b || (a === b && rng() < 0.5)) best = v;
  }
  return best.id;
}

/** 趣味消費の flavor 文 (ログ用)。 */
export function hobbyVerb(hobby: Hobby): string {
  return HOBBY_VERB[hobby];
}
