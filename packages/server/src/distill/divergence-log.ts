// 乖離ログ (§v1.4-C)。shadow sampling が記録した「教師 LLM と生徒 (DailyEngine) の食い違い」を
// メモリに溜め、JSONL (data/runtime/divergence.jsonl) へ追記する。
// JSONL は観測/研究素材 (追記失敗は致命でない)。蒸留の入力はメモリ側の直近ケース。

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { DivergenceCase } from '@pagus/sim';
import { dataDir } from '../load-data.js';

export class DivergenceLog {
  private readonly path: string;
  /** 蒸留待ちの乖離ケース (直近のみ保持)。 */
  private pending: DivergenceCase[] = [];
  /** 累計 (状態表示/ログ用)。 */
  private totalSampled = 0;
  private totalDiverged = 0;
  private readonly pendingMax: number;

  constructor(opts: { pendingMax?: number } = {}) {
    this.path = resolve(dataDir(), 'runtime', 'divergence.jsonl');
    this.pendingMax = opts.pendingMax ?? 50;
  }

  /** サンプル 1 件を記録する。乖離していれば蒸留待ちに積む。 */
  record(c: DivergenceCase, diverged: boolean): void {
    this.totalSampled += 1;
    if (diverged) {
      this.totalDiverged += 1;
      this.pending.push(c);
      if (this.pending.length > this.pendingMax) this.pending.shift();
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify({ diverged, ...c })}\n`, 'utf8');
    } catch {
      /* 観測ログの追記失敗は致命でない (蒸留はメモリ側で続く) */
    }
  }

  /** 蒸留待ちの乖離ケース数。 */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** 累計サンプル/乖離数 (ログ用)。 */
  get stats(): { sampled: number; diverged: number } {
    return { sampled: this.totalSampled, diverged: this.totalDiverged };
  }

  /**
   * 蒸留に使うケースを最大 n 件取り出す (取り出した分は消費 = 同じ乖離で何度も蒸留しない)。
   * replay ゲートで棄却されても消費される — 同じケース束での再試行はしない (次の乖離を待つ)。
   */
  takeCases(n: number): DivergenceCase[] {
    const taken = this.pending.slice(0, n);
    this.pending = this.pending.slice(taken.length);
    return taken;
  }
}
