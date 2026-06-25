// 実時間ペースの導出。1 日(=1ターム) = 24h ÷ その月の日数。
// セグメント間隔 = ターム ÷ segmentsPerDay。dev は accel で短縮する。

const DAY_MS = 24 * 60 * 60 * 1000;

export function termRealMs(daysInMonth: number): number {
  return DAY_MS / daysInMonth;
}

export function segmentRealMs(daysInMonth: number, segmentsPerDay: number): number {
  return termRealMs(daysInMonth) / segmentsPerDay;
}

export interface PaceOptions {
  /** dev 加速倍率 (1 = 本番ペース)。例 600 でおよそ 0.4 秒/セグメント。 */
  accel: number;
  /** 加速後の下限 (ms)。描画が追いつくよう。 */
  minMs: number;
}

/** 現在の月日数から、加速を効かせたセグメント tick 間隔を返す。 */
export function pacedSegmentMs(daysInMonth: number, segmentsPerDay: number, opts: PaceOptions): number {
  const base = segmentRealMs(daysInMonth, segmentsPerDay) / Math.max(1, opts.accel);
  return Math.max(opts.minMs, base);
}
