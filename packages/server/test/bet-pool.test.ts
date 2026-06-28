import { describe, it, expect } from 'vitest';
import { BetPool } from '../src/bet-pool.js';

describe('BetPool (裁判ベット §3)', () => {
  it('place は増額のみ可、別 pick への乗り換えは reject', () => {
    const pool = new BetPool();
    expect(pool.place('inc1', 'a', 'death', 10).ok).toBe(true);
    // 同 pick への増額。
    expect(pool.place('inc1', 'a', 'death', 5).ok).toBe(true);
    expect(pool.yourBet('a')).toEqual({ pick: 'death', amount: 15 });
    // 別 pick へは乗り換え不可。
    const res = pool.place('inc1', 'a', 'educate', 5);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('乗り換え');
    // 乗り換え拒否後も賭けは変わらない。
    expect(pool.yourBet('a')).toEqual({ pick: 'death', amount: 15 });
  });

  it('新しい incidentId の裁判が始まったらプールはリセットされる', () => {
    const pool = new BetPool();
    pool.place('inc1', 'a', 'death', 10);
    expect(pool.totals()).toEqual({ death: 10, educate: 0 });
    pool.place('inc2', 'b', 'educate', 7); // incidentId 切替 → 前プール破棄
    expect(pool.currentIncidentId).toBe('inc2');
    expect(pool.totals()).toEqual({ death: 0, educate: 7 });
    expect(pool.yourBet('a')).toBeNull();
  });

  it('パリミュチュエル清算: 勝ち側へ賭金 + 負け側総額の按分 (端数切り捨て)', () => {
    const pool = new BetPool();
    pool.place('inc', 'A', 'death', 10);
    pool.place('inc', 'B', 'death', 30); // 勝ち側総額 40
    pool.place('inc', 'C', 'educate', 20);
    pool.place('inc', 'D', 'educate', 40); // 負け側総額 60
    const s = pool.settle('death');
    expect(s.refunded).toBe(false);
    expect(s.winners.sort()).toEqual(['A', 'B']);
    // A: 10 + floor(60*10/40)=10+15=25 / B: 30 + floor(60*30/40)=30+45=75
    expect(s.payouts.get('A')).toBe(25);
    expect(s.payouts.get('B')).toBe(75);
    // 負け側 C/D は払い戻し無し。
    expect(s.payouts.has('C')).toBe(false);
    expect(s.payouts.has('D')).toBe(false);
    // 清算後はプール空。
    expect(pool.totals()).toEqual({ death: 0, educate: 0 });
  });

  it('端数は切り捨て (払い戻し合計はプール総額以下)', () => {
    const pool = new BetPool();
    pool.place('inc', 'A', 'death', 3); // 勝ち側総額 3
    pool.place('inc', 'B', 'educate', 10); // 負け側総額 10
    const s = pool.settle('death');
    // A: 3 + floor(10*3/3)=3+10=13 (割り切れる例)
    expect(s.payouts.get('A')).toBe(13);
  });

  it('片側が空なら不成立 → 全額返金 (winners は空)', () => {
    const pool = new BetPool();
    pool.place('inc', 'A', 'death', 10);
    pool.place('inc', 'B', 'death', 5);
    // 教育側に誰も賭けていない → death が勝っても按分相手がいない。
    const s = pool.settle('death');
    expect(s.refunded).toBe(true);
    expect(s.winners).toEqual([]);
    expect(s.payouts.get('A')).toBe(10);
    expect(s.payouts.get('B')).toBe(5);
  });

  it('賭けの無い側が勝った場合も不成立で全額返金', () => {
    const pool = new BetPool();
    pool.place('inc', 'A', 'death', 10); // death 側のみ
    const s = pool.settle('educate'); // 勝ち側 (educate) が空
    expect(s.refunded).toBe(true);
    expect(s.winners).toEqual([]);
    expect(s.payouts.get('A')).toBe(10); // 負け側でも返金
  });
});
