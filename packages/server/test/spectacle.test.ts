import { describe, it, expect } from 'vitest';
import {
  SpectacleManager,
  RaidManager,
  type SpectacleConfig,
  type SpectacleDeps,
  type RaidConfig,
  type RaidDeps,
  type SeasonRecord,
} from '../src/spectacle.js';
import type { HighlightCard, LeaderboardEntry, SeasonWinner } from '@pagus/sim';

// --- SpectacleManager -----------------------------------------------------------

function makeSpectacle(over: Partial<SpectacleConfig> = {}, repOver: Partial<{ benevolence: number; malice: number; order: number }> = {}) {
  const karma = new Map<string, number>();
  const factions = new Map<string, 'guide' | 'incite'>();
  const rep = { benevolence: 0, malice: 0, order: 0, ...repOver };
  const rec = {
    highlights: [] as HighlightCard[][],
    seasons: [] as { number: number; winner: SeasonWinner }[],
    persisted: [] as SeasonRecord[],
  };
  const cfg: SpectacleConfig = {
    predictReward: 30,
    prayWindowMs: 30000,
    prayNeeded: 3,
    seasonMonths: 3,
    seasonReward: 50,
    ...over,
  };
  const deps: SpectacleDeps = {
    addKarma: (uid, amt) => karma.set(uid, (karma.get(uid) ?? 0) + amt),
    pushState: () => {},
    knownUserIds: () => [...new Set([...karma.keys(), ...factions.keys()])],
    factionOf: (uid) => factions.get(uid) ?? 'guide',
    reputation: () => rep,
    buildLeaderboard: () => [] as LeaderboardEntry[],
    broadcastHighlights: (cards) => rec.highlights.push(cards),
    broadcastSeason: (number, winner) => rec.seasons.push({ number, winner }),
    persistSeason: (r) => rec.persisted.push(r),
  };
  return { mgr: new SpectacleManager(cfg, deps), karma, factions, rep, rec };
}

describe('SpectacleManager 予測アワード (§v1.3-D ㉓)', () => {
  it('発生日を当てたユーザにだけ報酬を配り、判定は月1回だけ (idempotent)', () => {
    const { mgr, karma } = makeSpectacle();
    expect(mgr.predict('u1', 14, 30).ok).toBe(true); // 的中
    expect(mgr.predict('u2', 10, 30).ok).toBe(true); // 外れ
    const payouts = mgr.resolvePredictions(14);
    expect(payouts).toEqual([{ userId: 'u1', reward: 30 }]);
    expect(karma.get('u1')).toBe(30);
    expect(karma.get('u2')).toBeUndefined();
    // 2 回目は判定済みなので何も配らない。
    expect(mgr.resolvePredictions(14)).toEqual([]);
  });

  it('範囲外/非整数の予測は reject、発生後 (resolved) も reject', () => {
    const { mgr } = makeSpectacle();
    expect(mgr.predict('u1', 0, 30).ok).toBe(false);
    expect(mgr.predict('u1', 31, 30).ok).toBe(false);
    expect(mgr.predict('u1', 3.5, 30).ok).toBe(false);
    mgr.resolvePredictions(5);
    expect(mgr.predict('u1', 5, 30).ok).toBe(false); // 発生後
    mgr.resetMonth(); // 新しい月で再開
    expect(mgr.predict('u1', 5, 30).ok).toBe(true);
  });

  it('1 ユーザ 1 予測 (上書き)', () => {
    const { mgr, karma } = makeSpectacle();
    mgr.predict('u1', 10, 30);
    mgr.predict('u1', 20, 30); // 上書き
    mgr.resolvePredictions(20);
    expect(karma.get('u1')).toBe(30);
  });
});

describe('SpectacleManager 月間MVP (§v1.3-D ㉔)', () => {
  it('最多得票の住民を返し、票はリセットされる', () => {
    const { mgr } = makeSpectacle();
    mgr.voteMvp('u1', 'v_a', true);
    mgr.voteMvp('u2', 'v_a', true);
    mgr.voteMvp('u3', 'v_b', true);
    expect(mgr.resolveMvp()).toEqual({ villagerId: 'v_a', votes: 2 });
    expect(mgr.resolveMvp()).toBeNull(); // リセット済
  });

  it('生存していない対象は reject、票が無ければ null', () => {
    const { mgr } = makeSpectacle();
    expect(mgr.voteMvp('u1', 'v_x', false).ok).toBe(false);
    expect(mgr.voteMvp('u1', '', true).ok).toBe(false);
    expect(mgr.resolveMvp()).toBeNull();
  });
});

describe('SpectacleManager 観客の祈り (§v1.3-D ㉕)', () => {
  it('異なる userId が prayNeeded 人揃うと発火しウィンドウをリセットする', () => {
    const { mgr } = makeSpectacle({ prayNeeded: 3, prayWindowMs: 30000 });
    expect(mgr.pray('u1', 0)).toEqual({ fired: false, count: 1 });
    expect(mgr.pray('u2', 100)).toEqual({ fired: false, count: 2 });
    expect(mgr.pray('u1', 200)).toEqual({ fired: false, count: 2 }); // 同一 userId は distinct
    expect(mgr.pray('u3', 300)).toEqual({ fired: true, count: 3 }); // 発火
    expect(mgr.pray('u1', 400)).toEqual({ fired: false, count: 1 }); // リセット後
  });

  it('ウィンドウを超えた古い祈りは数えない', () => {
    const { mgr } = makeSpectacle({ prayNeeded: 3, prayWindowMs: 1000 });
    mgr.pray('u1', 0);
    mgr.pray('u2', 1500);
    // now=2000: u1(0) は 2000 経過で窓外に掃除、u2(1500)は窓内に残る → u2+u3 で 2 人。
    expect(mgr.pray('u3', 2000)).toEqual({ fired: false, count: 2 });
  });
});

describe('SpectacleManager シーズン (§v1.3-D ㉚)', () => {
  it('seasonMonths ごとに勝敗確定し、勝利陣営に報酬・番号++・保存・broadcast', () => {
    const { mgr, karma, factions, rec } = makeSpectacle(
      { seasonMonths: 2, seasonReward: 50 },
      { benevolence: 0.6, order: 0.5, malice: 0.2 }, // guide=1.1 > incite=0.2
    );
    factions.set('g1', 'guide');
    factions.set('i1', 'incite');
    karma.set('g1', 0);
    karma.set('i1', 0);
    expect(mgr.advanceSeasonMonth()).toBeNull(); // 1 月目はまだ
    const res = mgr.advanceSeasonMonth(); // 2 月目で確定
    expect(res).toMatchObject({ number: 1, winner: 'guide' });
    expect(karma.get('g1')).toBe(50); // guide だけ報酬
    expect(karma.get('i1')).toBe(0);
    expect(rec.persisted).toHaveLength(1);
    expect(rec.persisted[0]).toMatchObject({ number: 1, winner: 'guide' });
    expect(rec.seasons).toEqual([{ number: 1, winner: 'guide' }]);
    expect(mgr.currentSeason()).toBe(2); // 番号 ++
  });

  it('引き分けは報酬なし', () => {
    const { mgr, karma, factions } = makeSpectacle(
      { seasonMonths: 1, seasonReward: 50 },
      { benevolence: 0.1, order: 0.1, malice: 0.2 }, // guide=0.2 == incite=0.2
    );
    factions.set('g1', 'guide');
    karma.set('g1', 0);
    const res = mgr.advanceSeasonMonth();
    expect(res?.winner).toBe('draw');
    expect(karma.get('g1')).toBe(0);
  });
});

describe('SpectacleManager ハイライト (§v1.3-D ㉑)', () => {
  it('上限30で積み、broadcast する', () => {
    const { mgr } = makeSpectacle();
    for (let i = 0; i < 35; i += 1) mgr.recordHighlight('6月1日', `t${i}`, 'other', `s${i}`);
    const hl = mgr.highlights();
    expect(hl).toHaveLength(30);
    expect(hl[0]?.title).toBe('t5'); // 古い 5 件が押し出された
    expect(hl[29]?.title).toBe('t34');
  });
});

// --- RaidManager ----------------------------------------------------------------

function makeRaid(over: Partial<RaidConfig> = {}, rng: () => number = () => 0) {
  const karma = new Map<string, number>([['u1', 100], ['u2', 100]]);
  const rec = {
    spawned: 0,
    despawned: [] as string[],
    failures: 0,
    chronicles: [] as string[],
    highlights: [] as string[],
    broadcasts: [] as { active: boolean; hp: number }[],
    snapshots: 0,
  };
  const cfg: RaidConfig = { hp: 100, windowMs: 120000, reward: 50, chance: 0.05, ...over };
  const deps: RaidDeps = {
    spawnVillain: () => { rec.spawned += 1; return { id: `villain_${rec.spawned}`, name: '凶賊' }; },
    despawnVillain: (id) => rec.despawned.push(id),
    spend: (uid, amt) => {
      const bal = karma.get(uid) ?? 0;
      if (bal < amt) return false;
      karma.set(uid, bal - amt);
      return true;
    },
    reward: (uid, amt) => karma.set(uid, (karma.get(uid) ?? 0) + amt),
    pushState: () => {},
    applyFailure: () => { rec.failures += 1; },
    chronicle: (text) => rec.chronicles.push(text),
    highlight: (title) => rec.highlights.push(title),
    broadcast: (active, _name, hp) => rec.broadcasts.push({ active, hp }),
    snapshot: () => { rec.snapshots += 1; },
  };
  return { mgr: new RaidManager(cfg, deps, rng), karma, rec };
}

describe('RaidManager 出現 (§v1.3-D ㉙)', () => {
  it('chance 未満で出現、進行中は多重出現しない', () => {
    const { mgr, rec } = makeRaid({ chance: 0.5 }, () => 0.1); // 0.1 < 0.5
    expect(mgr.maybeSpawn(0)).toBe(true);
    expect(rec.spawned).toBe(1);
    expect(mgr.isActive()).toBe(true);
    expect(mgr.maybeSpawn(0)).toBe(false); // 進行中
    expect(rec.spawned).toBe(1);
  });

  it('chance 以上の乱数では出現しない', () => {
    const { mgr } = makeRaid({ chance: 0.05 }, () => 0.9);
    expect(mgr.maybeSpawn(0)).toBe(false);
    expect(mgr.isActive()).toBe(false);
  });
});

describe('RaidManager 討伐 (§v1.3-D ㉙)', () => {
  it('総ダメージが hp を超えたら討伐 → 報酬を投入比例で配り villain 退場', () => {
    const { mgr, karma, rec } = makeRaid({ hp: 100, reward: 50 });
    mgr.spawn(0);
    expect(mgr.strike('u1', 60, 0)).toEqual({ ok: true, defeated: false }); // hp 40 残
    expect(mgr.strike('u2', 40, 0)).toEqual({ ok: true, defeated: true }); // 討伐
    // 報酬 50 を 60:40 比で配分 → u1=30, u2=20。
    // karma: u1 100-60+30=70, u2 100-40+20=80。
    expect(karma.get('u1')).toBe(70);
    expect(karma.get('u2')).toBe(80);
    expect(rec.despawned).toEqual(['villain_1']);
    expect(rec.highlights).toContain('レイド討伐');
    expect(mgr.isActive()).toBe(false);
  });

  it('カルマ不足/非整数/出現していない時は reject', () => {
    const { mgr } = makeRaid();
    expect(mgr.strike('u1', 10, 0).ok).toBe(false); // 未出現
    mgr.spawn(0);
    expect(mgr.strike('u1', 0, 0).ok).toBe(false); // 0
    expect(mgr.strike('u1', 3.5, 0).ok).toBe(false); // 非整数
    expect(mgr.strike('u1', 9999, 0).ok).toBe(false); // カルマ不足
  });
});

describe('RaidManager 失敗 (§v1.3-D ㉙)', () => {
  it('制限時間が過ぎると失敗 = 村に大被害 + villain 退場', () => {
    const { mgr, rec } = makeRaid({ windowMs: 1000 });
    mgr.spawn(0);
    mgr.tick(500); // まだ時間内
    expect(rec.failures).toBe(0);
    expect(mgr.isActive()).toBe(true);
    mgr.tick(1000); // 時間切れ
    expect(rec.failures).toBe(1);
    expect(rec.despawned).toEqual(['villain_1']);
    expect(mgr.isActive()).toBe(false);
  });

  it('時間切れ後の strike は reject', () => {
    const { mgr } = makeRaid({ windowMs: 1000 });
    mgr.spawn(0);
    expect(mgr.strike('u1', 10, 2000).ok).toBe(false); // 締切後
  });
});
