// フィールドアイテム (§16) — 人手で配置するランダム配布物。LLM 非依存の決定的処理。
//
// プレイヤーがフィールドに「アイテム」を配置する (カルマ消費なし・ランダム配布)。
//   貴金属 (precious) → 拾った住民が富む (§15 経済へ波及、クズ化の誘因)。
//   薬物 (drug) → 拾った住民の気が荒れ (anger+) 非行に走りやすくなる (eventParam 'drug')。
// 推しに直接送ることもできる (フィールドを介さず対象へ即適用)。
// フィールド上のアイテムは日末に最寄りの生存住民が拾って消える。

import type { World, Villager, FieldItem, FieldItemKind, GridPos } from './types/index.js';
import { bumpEventParam, awakeVillagers } from './world.js';

/** プレイヤーが選べる種別。'random' は配置時に precious/drug へ解決する。 */
export type ItemKindChoice = 'random' | FieldItemKind;

/** アイテムのチューニング値 (§16)。 */
export interface ItemConfig {
  /** 貴金属を拾った時の所持金増加。 */
  preciousWealth: number;
  /** 薬物を拾った時の怒り上昇 (-1..1 にクランプ)。 */
  drugAnger: number;
  /** 薬物を拾った時の所持金減少 (依存の浪費)。 */
  drugWealthLoss: number;
}

export const DEFAULT_ITEMS: ItemConfig = {
  preciousWealth: 150,
  drugAnger: 0.3,
  drugWealthLoss: 20,
};

/** 薬物の累積を表す eventParam タグ (behavior-rules の base_drugged が参照)。 */
export const DRUG_TAG = 'drug';

export const ITEM_LABELS: Record<FieldItemKind, string> = {
  precious: '貴金属',
  drug: '薬物',
};

/** 選択を実種別へ解決する ('random' は rng で precious/drug 半々)。 */
export function resolveItemKind(choice: ItemKindChoice, rng: () => number): FieldItemKind {
  if (choice === 'random') return rng() < 0.5 ? 'precious' : 'drug';
  return choice;
}

/** アイテムの効果を 1 体に適用する (§16)。precious=富む / drug=荒れる。 */
export function applyItemEffect(villager: Villager, kind: FieldItemKind, cfg: ItemConfig = DEFAULT_ITEMS): void {
  if (kind === 'precious') {
    villager.wealth += cfg.preciousWealth;
    return;
  }
  // drug: 怒りを上げ、所持金を削り、依存タグを積む (非行傾向は behavior-rule が拾う)。
  const anger = (villager.emotion.axes['anger'] ?? 0) + cfg.drugAnger;
  villager.emotion.axes['anger'] = Math.min(1, Math.max(-1, anger));
  villager.wealth = Math.max(0, villager.wealth - cfg.drugWealthLoss);
  bumpEventParam(villager, DRUG_TAG, 1);
}

/** 拾われたアイテムの記録 (server がログに使う)。 */
export interface ItemPickup {
  villagerId: string;
  name: string;
  kind: FieldItemKind;
}

function chebyshev(a: GridPos, b: GridPos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** 1 軸ぶんの符号 (対象へ 1 歩近づく移動量)。 */
function stepToward(from: number, to: number): number {
  return Math.sign(to - from);
}

/** これ以下の距離なら「手が届く」= その場で拾える。 */
const PICKUP_RANGE = 1;

/**
 * セグメントごとのアイテム回収 (§v1.4-A 体感即時化): 各アイテムへ最寄りの起きている住民が
 * 1 歩ずつ取りに歩き、手が届いたら (chebyshev <= 1) その場で拾って効果適用する。
 * 旧「日末に一括拾得」だと配置の手応えが翌日まで見えないため、数セグメント以内に回収される。
 * 起きている住民がいなければ動かさない (アイテムは残る)。server が kisho の各 tick で呼ぶ。
 */
export function stepItemPickups(world: World, cfg: ItemConfig = DEFAULT_ITEMS): ItemPickup[] {
  if (world.items.length === 0) return [];
  const awake = awakeVillagers(world);
  if (awake.length === 0) return [];
  const pickups: ItemPickup[] = [];
  const remaining: FieldItem[] = [];
  for (const item of world.items) {
    let nearest = awake[0];
    if (!nearest) continue;
    for (const v of awake) {
      if (chebyshev(v.position, item.position) < chebyshev(nearest.position, item.position)) nearest = v;
    }
    if (chebyshev(nearest.position, item.position) <= PICKUP_RANGE) {
      applyItemEffect(nearest, item.kind, cfg);
      pickups.push({ villagerId: nearest.id, name: nearest.name, kind: item.kind });
    } else {
      // 最寄りが 1 歩近づく (拾いに向かう姿が見える)。うろつき移動の後に上書きされうるが、
      // 毎セグメント寄るので数 tick で到達する。
      nearest.position = {
        x: nearest.position.x + stepToward(nearest.position.x, item.position.x),
        y: nearest.position.y + stepToward(nearest.position.y, item.position.y),
      };
      remaining.push(item);
    }
  }
  world.items = remaining;
  return pickups;
}

/**
 * 日末: フィールド上の全アイテムを最寄りの生存住民が拾う (§16)。効果を適用し world.items を空にする。
 * 生存住民がいなければアイテムは残す (拾い手なし)。
 */
export function collectItems(world: World, cfg: ItemConfig = DEFAULT_ITEMS): ItemPickup[] {
  const alive = [...world.villagers.values()].filter((v) => v.alive);
  if (alive.length === 0) return [];
  const pickups: ItemPickup[] = [];
  for (const item of world.items) {
    let nearest = alive[0];
    if (!nearest) continue;
    for (const v of alive) {
      if (chebyshev(v.position, item.position) < chebyshev(nearest.position, item.position)) nearest = v;
    }
    applyItemEffect(nearest, item.kind, cfg);
    pickups.push({ villagerId: nearest.id, name: nearest.name, kind: item.kind });
  }
  world.items = [];
  return pickups;
}
