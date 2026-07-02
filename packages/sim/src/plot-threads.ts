// 火種 (PlotThread, §v1.4-B) の管理 — 追加/減衰/加熱。LLM 非依存の決定的処理。
// 生成点: 判決 (冤罪/遺恨/更生)・和解・偽証・偽予言・しきたり追加・推しの死 (server hook)。

import type { World, VillagerId, PlotThread, PlotThreadKind, PlotActor } from './types/index.js';

/** 火種のチューニング値 (§v1.4-B)。数値は当て推量で観戦調整前提 (config arc.*)。 */
export interface PlotConfig {
  /** 火種の上限。超えたら heat 最小の 1 件を捨てる。 */
  threadsMax: number;
  /** 日末の減衰量。0 以下で火種は消える。 */
  heatDecay: number;
  /** 関係者が事件に関わったときの加熱量。 */
  heatOnIncident: number;
}

export const DEFAULT_PLOT: PlotConfig = {
  threadsMax: 8,
  heatDecay: 0.05,
  heatOnIncident: 0.2,
};

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export interface AddThreadInput {
  kind: PlotThreadKind;
  actors: PlotActor[];
  heat: number;
  note: string;
}

/**
 * 火種を 1 件足す。上限超過時は heat 最小の既存火種を捨てる (新しい火種を優先)。
 * id は呼び出し側 (TermMachine) が通し番号で振る。
 */
export function addThread(world: World, input: AddThreadInput, id: string, cfg: PlotConfig = DEFAULT_PLOT): PlotThread {
  const thread: PlotThread = {
    id,
    kind: input.kind,
    actors: input.actors,
    heat: clamp01(input.heat),
    bornTerm: world.term,
    note: input.note,
  };
  world.plotThreads.push(thread);
  if (world.plotThreads.length > cfg.threadsMax) {
    let minIdx = 0;
    for (let i = 1; i < world.plotThreads.length; i += 1) {
      const cur = world.plotThreads[i];
      const min = world.plotThreads[minIdx];
      if (cur && min && cur.heat < min.heat) minIdx = i;
    }
    world.plotThreads.splice(minIdx, 1);
  }
  return thread;
}

/** 日末の減衰。heat が 0 以下になった火種を除去して返す。 */
export function decayThreads(world: World, cfg: PlotConfig = DEFAULT_PLOT): PlotThread[] {
  const burnt: PlotThread[] = [];
  world.plotThreads = world.plotThreads.filter((t) => {
    t.heat = t.heat - cfg.heatDecay;
    if (t.heat > 0) return true;
    burnt.push(t);
    return false;
  });
  return burnt;
}

/** 関係者 (ids) が絡む火種を加熱する。加熱した火種数を返す。 */
export function heatThreadsInvolving(world: World, ids: readonly VillagerId[], cfg: PlotConfig = DEFAULT_PLOT): number {
  let n = 0;
  const idSet = new Set(ids);
  for (const t of world.plotThreads) {
    if (!t.actors.some((a) => idSet.has(a.id))) continue;
    t.heat = clamp01(t.heat + cfg.heatOnIncident);
    n += 1;
  }
  return n;
}

/** id 指定で火種を消す (月次事件が火種を回収したとき)。消えたら true。 */
export function resolveThread(world: World, threadId: string): boolean {
  const before = world.plotThreads.length;
  world.plotThreads = world.plotThreads.filter((t) => t.id !== threadId);
  return world.plotThreads.length < before;
}
