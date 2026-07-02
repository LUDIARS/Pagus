// 火種 (PlotThread, §v1.4-B) — 事件の結末が残す持ち越し状態。
// 事件を「点」から「線」にする: 判決/和解/偽証/しきたり/偽予言が火種を残し、
// 月初の事件スケジューラ (incident-arc) が火種から次のテーマを選ぶ。

import type { VillagerId } from './villager.js';

/** 火種の種類。 */
export type PlotThreadKind =
  | 'grudge' // 遺恨: 冤罪死・推し処刑・偽証の関係者が恨む
  | 'unresolved' // 未解決: 真犯人 (事件用キャラ) が生存して居座る
  | 'redemption' // 更生: 教育された者の再犯/模範の分岐持ち
  | 'rumor' // 噂: 亡霊の噂/偽予言/くすぶる和解の後日談
  | 'ruleViolation'; // しきたり: 新しい掟が破られる火種

/** 火種に関わる者。退場者も名前で参照できるよう id と name を両方持つ。 */
export interface PlotActor {
  id: VillagerId;
  name: string;
}

/** 火種 1 件。heat は 0..1 で日末に減衰し、関連事件で加熱される。 */
export interface PlotThread {
  id: string;
  kind: PlotThreadKind;
  actors: PlotActor[];
  /** 燃え具合 (0..1)。日末に減衰、0 以下で消える。関連イベントで加熱。 */
  heat: number;
  /** 生まれたターム。 */
  bornTerm: number;
  /** 1 行の文脈 (事件デザイン LLM / 観戦者向け)。 */
  note: string;
}
