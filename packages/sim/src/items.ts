// フィールドアイテム (§16) — 人手で配置するランダム配布物。LLM 非依存の決定的処理。
//
// プレイヤーがフィールドに「アイテム」を配置する (カルマ消費なし・ランダム配布)。
//   貴金属 (precious) → 拾った住民が富む (§15 経済へ波及、クズ化の誘因)。
//   薬物 (drug) → 拾った住民の気が荒れ (anger+) 非行に走りやすくなる (eventParam 'drug')。
// 推しに直接送ることもできる (フィールドを介さず対象へ即適用)。
// フィールド上のアイテムは日末に最寄りの生存住民が拾って消える。

import type { World, Villager, FieldItem, FieldItemKind, GridPos } from './types/index.js';
import { bumpEventParam } from './world.js';

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
