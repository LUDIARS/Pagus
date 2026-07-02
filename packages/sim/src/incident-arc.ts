// 事件アーク (IncidentArc, §v1.4-B) — 火種から次の事件テーマを選ぶ派生表。
// 構造は決定的 (データ駆動)、肉付けは LLM (scheduleMonthlyIncident の arcHint 経由)。
// 派生表は data/incident-arcs.json で差し替え可能 (server が load して注入)。

import type { World, PlotThread, PlotThreadKind } from './types/index.js';
import type { Virtue } from './virtue.js';

/** 派生表の 1 行: 火種の条件 → テーマ候補 (重み付き)。 */
export interface ArcRule {
  when: {
    threadKind: PlotThreadKind;
    /** heat がこの値を超えるときだけ候補になる。 */
    heatAbove: number;
    /** 村の徳目がこの値を超えるときだけ (任意)。 */
    reputationAbove?: { axis: Virtue; value: number };
  };
  themes: Array<{ seed: string; weight: number }>;
}

/** 組込みの派生表。data/incident-arcs.json が無いときの正規の既定値。 */
export const DEFAULT_ARCS: ArcRule[] = [
  {
    when: { threadKind: 'grudge', heatAbove: 0.35 },
    themes: [
      { seed: '遺恨の復讐', weight: 3 },
      { seed: '決闘の申し込み', weight: 1 },
    ],
  },
  {
    when: { threadKind: 'unresolved', heatAbove: 0.25 },
    themes: [
      { seed: '連続犯の再犯', weight: 3 },
      { seed: '真犯人の影がちらつく', weight: 2 },
    ],
  },
  {
    when: { threadKind: 'redemption', heatAbove: 0.35 },
    themes: [
      { seed: '更生者の再犯疑惑', weight: 2 },
      { seed: '模範者への嫉妬', weight: 2 },
    ],
  },
  {
    when: { threadKind: 'rumor', heatAbove: 0.45 },
    themes: [
      { seed: '亡霊騒ぎ', weight: 2 },
      { seed: '噂が現実になる騒動', weight: 2 },
    ],
  },
  {
    when: { threadKind: 'ruleViolation', heatAbove: 0.25, reputationAbove: { axis: 'order', value: 0.4 } },
    themes: [{ seed: 'しきたり破りの告発', weight: 3 }],
  },
];

/** 派生表 JSON (unknown) を検証して ArcRule[] にする。不正は throw (無言フォールバック禁止)。 */
export function validateArcs(raw: unknown): ArcRule[] {
  if (!Array.isArray(raw)) throw new Error('incident-arcs: 配列である必要があります');
  const kinds: PlotThreadKind[] = ['grudge', 'unresolved', 'redemption', 'rumor', 'ruleViolation'];
  return raw.map((row, i) => {
    const r = row as Partial<ArcRule>;
    if (!r.when || !kinds.includes(r.when.threadKind)) {
      throw new Error(`incident-arcs[${i}]: when.threadKind が不正`);
    }
    if (typeof r.when.heatAbove !== 'number') throw new Error(`incident-arcs[${i}]: when.heatAbove が不正`);
    if (!Array.isArray(r.themes) || r.themes.length === 0) throw new Error(`incident-arcs[${i}]: themes が不正`);
    for (const t of r.themes) {
      if (typeof t.seed !== 'string' || typeof t.weight !== 'number' || t.weight <= 0) {
        throw new Error(`incident-arcs[${i}]: theme が不正 (seed 文字列 + 正の weight)`);
      }
    }
    return r as ArcRule;
  });
}

/** アークが選んだテーマ (scheduleMonthlyIncident への arcHint)。 */
export interface ArcPick {
  themeSeed: string;
  /** 拾った火種。月次事件が発火・裁判決着したら回収 (resolveThread) する。 */
  thread: PlotThread;
}

/**
 * 火種と村の状態から次の事件テーマを選ぶ (§v1.4-B)。
 * heat の高い火種から派生表を引き、マッチした行のテーマ候補を重み付きで 1 つ選ぶ。
 * マッチする火種が無ければ null (= 従来どおり LLM の自由テーマ)。
 */
export function pickArcTheme(world: World, arcs: readonly ArcRule[], rng: () => number): ArcPick | null {
  const sorted = [...world.plotThreads].sort((a, b) => b.heat - a.heat);
  for (const thread of sorted) {
    const candidates: Array<{ seed: string; weight: number }> = [];
    for (const rule of arcs) {
      if (rule.when.threadKind !== thread.kind) continue;
      if (thread.heat <= rule.when.heatAbove) continue;
      const rep = rule.when.reputationAbove;
      if (rep && world.reputation[rep.axis] <= rep.value) continue;
      candidates.push(...rule.themes);
    }
    if (candidates.length === 0) continue;
    const total = candidates.reduce((s, c) => s + c.weight, 0);
    let roll = rng() * total;
    for (const c of candidates) {
      roll -= c.weight;
      if (roll <= 0) return { themeSeed: c.seed, thread };
    }
    const last = candidates[candidates.length - 1];
    if (last) return { themeSeed: last.seed, thread };
  }
  return null;
}
