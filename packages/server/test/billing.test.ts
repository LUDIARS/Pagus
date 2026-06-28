import { describe, it, expect } from 'vitest';
import { PlayerState } from '../src/player-state.js';

// 課金モック (§v1.3-F)。env 既定: PAGUS_KARMA_RATE=0.5 / MAX=100。
describe('PlayerState 課金モック (§v1.3-F topup)', () => {
  it('topup はカルマと累計課金額を同額増やす', () => {
    const ps = new PlayerState();
    ps.topup('u', 100);
    expect(ps.get('u').karma).toBe(100);
    expect(ps.spent('u')).toBe(100);
    ps.topup('u', 500);
    expect(ps.get('u').karma).toBe(600); // 課金は max(100) を超えてよい
    expect(ps.spent('u')).toBe(600);
  });

  it('topup はカルマ上限 max を超過してよい (clamp しない)', () => {
    const ps = new PlayerState();
    ps.topup('u', 1000);
    expect(ps.get('u').karma).toBe(1000); // max=100 を無視
  });

  it('accrue は max 超過分 (topup) を削らず据置にする', () => {
    const ps = new PlayerState();
    ps.topup('u', 250); // max(100) 超過
    ps.accrue(0); // 基準
    ps.accrue(10_000); // 通常なら +5 だが、既に max 以上なので据置
    expect(ps.get('u').karma).toBe(250);
  });

  it('accrue は max 未満なら従来どおり加算し max でクランプする (回帰)', () => {
    const ps = new PlayerState();
    ps.get('u');
    ps.accrue(0);
    ps.accrue(2000); // +0.5×2 = 1
    expect(ps.get('u').karma).toBeCloseTo(1, 6);
    ps.accrue(1_000_000_000); // 巨大経過 → max=100 クランプ
    expect(ps.get('u').karma).toBe(100);
  });

  it('snapshot / leaderboard は spent を含む', () => {
    const ps = new PlayerState();
    ps.topup('u', 500);
    expect(ps.snapshot('u', 0).spent).toBe(500);
    const lb = ps.leaderboard();
    expect(lb.find((e) => e.userId === 'u')?.spent).toBe(500);
  });
});
