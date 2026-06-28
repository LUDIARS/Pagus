import { describe, it, expect } from 'vitest';
import { AuctionManager, type AuctionEffect } from '../src/auction.js';

/** 落札を記録する onSettle を仕込んで AuctionManager を作る。 */
function make(periodMs = 1000, now = 0) {
  const settled: Array<{ effect: AuctionEffect; lotId: string; userId: string; amount: number }> = [];
  let changes = 0;
  const mgr = new AuctionManager(
    periodMs,
    now,
    (effect, lotId, userId, amount) => settled.push({ effect, lotId, userId, amount }),
    () => { changes += 1; },
  );
  return { mgr, settled, getChanges: () => changes };
}

describe('AuctionManager (オークション §v1.3-B ②)', () => {
  it('初期は最初のロット (sanction_free) を出品し、最高額0', () => {
    const { mgr } = make(1000, 0);
    const v = mgr.view(0);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ id: 'sanction_free', highBid: 0, highUserId: null, endsInMs: 1000 });
  });

  it('入札は増額のみ受理し、最高額/最高入札者を更新する', () => {
    const { mgr, getChanges } = make(1000, 0);
    expect(mgr.bid('sanction_free', 'a', 10, 0).ok).toBe(true);
    expect(mgr.bid('sanction_free', 'b', 20, 0).ok).toBe(true);
    expect(mgr.view(0)[0]).toMatchObject({ highBid: 20, highUserId: 'b' });
    expect(getChanges()).toBe(2);
    // 同額・減額は reject。
    const lower = mgr.bid('sanction_free', 'a', 20, 0);
    expect(lower.ok).toBe(false);
    if (!lower.ok) expect(lower.reason).toContain('高く');
  });

  it('別ロット / 非整数 / 締切後の入札は reject', () => {
    const { mgr } = make(1000, 0);
    expect(mgr.bid('virtue_boost', 'a', 10, 0).ok).toBe(false); // 現ロットでない
    expect(mgr.bid('sanction_free', 'a', 2.5, 0).ok).toBe(false); // 非整数
    expect(mgr.bid('sanction_free', 'a', 10, 1000).ok).toBe(false); // 締切後
  });

  it('締切時に最高入札者が落札し、次ロットへローテして最高額をリセット', () => {
    const { mgr, settled } = make(1000, 0);
    mgr.bid('sanction_free', 'a', 10, 0);
    mgr.bid('sanction_free', 'b', 25, 0);
    mgr.tick(500); // まだ締切前 → 何もしない
    expect(settled).toHaveLength(0);
    mgr.tick(1000); // 締切 → 落札
    expect(settled).toEqual([{ effect: 'sanction_free', lotId: 'sanction_free', userId: 'b', amount: 25 }]);
    // 次ロット (virtue_boost) へ。最高額リセット・締切更新。
    const v = mgr.view(1000);
    expect(v[0]).toMatchObject({ id: 'virtue_boost', highBid: 0, highUserId: null, endsInMs: 1000 });
  });

  it('入札の無いまま締切ても落札なし、ロットだけローテする', () => {
    const { mgr, settled } = make(1000, 0);
    mgr.tick(1000);
    expect(settled).toHaveLength(0);
    expect(mgr.view(1000)[0]?.id).toBe('virtue_boost');
    // 3 周目で card_grant → 一巡して sanction_free へ。
    mgr.tick(2000);
    expect(mgr.view(2000)[0]?.id).toBe('card_grant');
    mgr.tick(3000);
    expect(mgr.view(3000)[0]?.id).toBe('sanction_free');
  });
});
