// LLM コストログ (§7)。各 invoke を model→単価表で概算し、累計/用途別/直近を蓄積する。
// server 実行時のみ使う (Date.now で記録時刻を打つ)。stub モードでは記録しない。
//
// 単価は概算 (per 1M tokens, USD)。model 文字列で tier を判定する:
//   opus≈{in:5,out:25} / sonnet≈{in:3,out:15} / haiku≈{in:0.8,out:4}
//   GPT-5.6 Sol={in:5,out:30} / Terra={in:2.5,out:15} / Luna={in:1,out:6}
//   その他 codex|gpt≈{in:2,out:10}
//   不明モデルは {in:0,out:0} (トークンは数えるが $0)。

import type { CostSummary, CostKindSummary, CostEntry } from '@pagus/sim';

/** Brain 層から呼ぶコスト計上フック。 */
export type CostSink = (e: CostRecordInput) => void;

/** record の入力 (1 回の LLM 呼び出し)。 */
export interface CostRecordInput {
  kind: string;
  provider: string;
  model: string;
  inTokens: number;
  outTokens: number;
}

/** per 1M tokens の単価 (USD)。 */
interface Rate {
  in: number;
  out: number;
}

const RATES = {
  opus: { in: 5, out: 25 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 0.8, out: 4 },
  gpt56Sol: { in: 5, out: 30 },
  gpt56Terra: { in: 2.5, out: 15 },
  gpt56Luna: { in: 1, out: 6 },
  gpt: { in: 2, out: 10 },
  unknown: { in: 0, out: 0 },
} as const satisfies Record<string, Rate>;

/** model 文字列から単価を引く (含有判定)。不明は $0 (トークンのみ計上)。 */
function rateFor(model: string): Rate {
  const m = model.toLowerCase();
  if (m.includes('opus')) return RATES.opus;
  if (m.includes('sonnet')) return RATES.sonnet;
  if (m.includes('haiku')) return RATES.haiku;
  if (m.includes('gpt-5.6-sol')) return RATES.gpt56Sol;
  if (m.includes('gpt-5.6-terra')) return RATES.gpt56Terra;
  if (m.includes('gpt-5.6-luna')) return RATES.gpt56Luna;
  if (m.includes('codex') || m.includes('gpt')) return RATES.gpt;
  return RATES.unknown;
}

/** 直近に保持する件数 (§7)。 */
const RECENT_CAP = 30;

export class CostLog {
  private total = 0;
  private callCount = 0;
  private readonly kinds = new Map<string, CostKindSummary>();
  /** 古い順のリングバッファ (summary で新しい順に反転)。 */
  private readonly recentBuf: CostEntry[] = [];

  /** 1 回の LLM 呼び出しを計上する。 */
  record(e: CostRecordInput): void {
    const rate = rateFor(e.model);
    const costUsd = (e.inTokens * rate.in + e.outTokens * rate.out) / 1_000_000;
    this.total += costUsd;
    this.callCount += 1;

    const k = this.kinds.get(e.kind) ?? { calls: 0, usd: 0, inTokens: 0, outTokens: 0 };
    k.calls += 1;
    k.usd += costUsd;
    k.inTokens += e.inTokens;
    k.outTokens += e.outTokens;
    this.kinds.set(e.kind, k);

    this.recentBuf.push({
      kind: e.kind,
      model: e.model,
      inTokens: e.inTokens,
      outTokens: e.outTokens,
      costUsd,
      at: Date.now(),
    });
    if (this.recentBuf.length > RECENT_CAP) this.recentBuf.shift();
  }

  /** 配信用の集計 (recent は新しい順)。 */
  summary(): CostSummary {
    return {
      totalUsd: this.total,
      calls: this.callCount,
      byKind: Object.fromEntries([...this.kinds.entries()].map(([k, v]) => [k, { ...v }])),
      recent: [...this.recentBuf].reverse(),
    };
  }
}
