import { describe, it, expect } from 'vitest';
import { PlayerState } from '../src/player-state.js';

// env 既定値前提 (PAGUS_KARMA_RATE=0.5 / MAX=100 / INCITE=10 / SANCTION=30 / VIRTUE_K=1 /
// CHEER_INTERVAL_MS=180000 / CHEER_VIRTUE=0.05)。
const INTERVAL = 180000;

describe('PlayerState (カルマ/善性)', () => {
  it('accrue はカルマを増やし max でクランプする', () => {
    const ps = new PlayerState();
    ps.get('u');
    ps.accrue(0); // 初回は基準時刻を記録するだけ
    ps.accrue(2000); // +rate(0.5) × 2 秒 = 1.0
    expect(ps.get('u').karma).toBeCloseTo(1.0, 6);
    ps.accrue(1_000_000_000); // 巨大経過 → max でクランプ
    expect(ps.get('u').karma).toBe(100);
  });

  it('spend はカルマが足りれば引いて true、足りなければ false', () => {
    const ps = new PlayerState();
    ps.get('u');
    expect(ps.spend('u', 10)).toBe(false); // karma 0
    ps.accrue(0);
    ps.accrue(30_000); // +0.5 × 30 = 15
    expect(ps.spend('u', 10)).toBe(true);
    expect(ps.get('u').karma).toBeCloseTo(5, 6);
    expect(ps.spend('u', 10)).toBe(false);
  });

  it('sanctionCost は善性 (virtue) で増える', () => {
    const ps = new PlayerState();
    expect(ps.sanctionCost('u')).toBeCloseTo(30, 6); // virtue 0
    ps.cheer('u', INTERVAL); // virtue += 0.05
    expect(ps.sanctionCost('u')).toBeCloseTo(30 * 1.05, 6);
  });

  it('cheer はインターバルを過ぎていないと false', () => {
    const ps = new PlayerState();
    expect(ps.cheer('u', INTERVAL)).toBe(true); // lastCheer 0 → 経過十分
    expect(ps.cheer('u', INTERVAL)).toBe(false); // 直後 → インターバル中
    expect(ps.canCheerInMs('u', INTERVAL)).toBe(INTERVAL);
    expect(ps.cheer('u', INTERVAL * 2)).toBe(true); // 再びインターバル経過
  });

  it('snapshot は karma/virtue/sanctionCost/canCheerInMs を返す', () => {
    const ps = new PlayerState();
    ps.cheer('u', INTERVAL);
    const snap = ps.snapshot('u', INTERVAL);
    expect(snap.virtue).toBeCloseTo(0.05, 6);
    expect(snap.sanctionCost).toBeCloseTo(30 * 1.05, 6);
    expect(snap.canCheerInMs).toBe(INTERVAL);
    expect(snap.karma).toBe(0);
  });
});
