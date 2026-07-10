import { describe, it, expect } from 'vitest';
import { CostLog } from '../src/llm/cost-log.js';

describe('CostLog (LLM コストログ §7)', () => {
  it('model 文字列で単価を引いて概算する (opus: in5/out25 per 1M)', () => {
    const log = new CostLog();
    log.record({ kind: 'world', provider: 'claude', model: 'claude-opus-4-8', inTokens: 1_000_000, outTokens: 1_000_000 });
    const s = log.summary();
    expect(s.calls).toBe(1);
    expect(s.totalUsd).toBeCloseTo(30, 6); // 5 + 25
    expect(s.byKind.world?.calls).toBe(1);
    expect(s.byKind.world?.usd).toBeCloseTo(30, 6);
  });

  it('GPT-5.6 family は各tierの公式単価、不明モデルは $0', () => {
    const log = new CostLog();
    log.record({ kind: 'action', provider: 'codex', model: 'gpt-5.6-sol', inTokens: 1_000_000, outTokens: 1_000_000 });
    log.record({ kind: 'action', provider: 'codex', model: 'gpt-5.6-terra', inTokens: 1_000_000, outTokens: 1_000_000 });
    log.record({ kind: 'action', provider: 'codex', model: 'gpt-5.6-luna', inTokens: 1_000_000, outTokens: 1_000_000 });
    log.record({ kind: 'action', provider: 'x', model: 'mystery', inTokens: 1_000_000, outTokens: 1_000_000 });
    const s = log.summary();
    expect(s.calls).toBe(4);
    expect(s.totalUsd).toBeCloseTo(59.5, 6); // Sol=35 + Terra=17.5 + Luna=7
    expect(s.byKind.action?.inTokens).toBe(4_000_000);
  });

  it('recent は新しい順で最大 30 件', () => {
    const log = new CostLog();
    for (let i = 0; i < 35; i++) {
      log.record({ kind: 'emotion', provider: 'claude', model: 'claude-haiku-4-5', inTokens: i, outTokens: 0 });
    }
    const s = log.summary();
    expect(s.recent).toHaveLength(30);
    expect(s.recent[0]?.inTokens).toBe(34); // 直近 = 最後に入れた 34
    expect(s.calls).toBe(35);
  });
});
