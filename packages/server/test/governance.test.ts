import { describe, it, expect } from 'vitest';
import { Governance, type GovernanceConfig, type GovernanceDeps, type RevoltSide, type FundEventKind } from '../src/governance.js';
import type { MartialMode, LawView } from '@pagus/sim';

const HUGE = 1_000_000_000;

/** 既定は全周期を巨大にして、テスト対象の周期だけ小さくする。 */
function makeConfig(over: Partial<GovernanceConfig> = {}): GovernanceConfig {
  return {
    mayorPeriodMs: HUGE,
    lawDeposit: 20,
    lawVoteMs: HUGE,
    revoltThreshold: 0.7,
    revoltStake: 10,
    revoltWindowMs: HUGE,
    martialStake: 25,
    martialCost: 100,
    martialDays: 2,
    taxPeriodMs: HUGE,
    taxAmount: 5,
    fundThreshold: 100,
    ...over,
  };
}

/** カルマ Map + 各副作用の記録を備えた偽 deps。 */
function makeDeps(initial: Record<string, number>, knownUsers: string[]) {
  const karma = new Map<string, number>(Object.entries(initial));
  const rec = {
    enacted: [] as string[],
    revolts: [] as RevoltSide[],
    martials: [] as { mode: MartialMode; days: number }[],
    funds: [] as FundEventKind[],
    chronicles: [] as string[],
    mayor: { userId: null as string | null, endsInMs: 0 },
    laws: [] as LawView[],
    revolt: { active: false, incite: 0, suppress: 0 },
    martial: { mode: null as MartialMode | null },
    fund: { amount: 0, threshold: 0 },
  };
  const deps: GovernanceDeps = {
    spend: (uid, amt) => {
      const bal = karma.get(uid) ?? 0;
      if (bal < amt) return false;
      karma.set(uid, bal - amt);
      return true;
    },
    refund: (uid, amt) => karma.set(uid, (karma.get(uid) ?? 0) + amt),
    take: (uid, amt) => {
      const bal = karma.get(uid) ?? 0;
      const taken = Math.min(bal, amt);
      karma.set(uid, bal - taken);
      return taken;
    },
    pushState: () => {},
    knownUserIds: () => knownUsers,
    enactLaw: (text) => { rec.enacted.push(text); return true; },
    applyRevolt: (side) => rec.revolts.push(side),
    activateMartial: (mode, days) => rec.martials.push({ mode, days }),
    fundEvent: (kind) => rec.funds.push(kind),
    chronicle: (text) => rec.chronicles.push(text),
    broadcastMayor: (userId, endsInMs) => { rec.mayor = { userId, endsInMs }; },
    broadcastLaws: (items) => { rec.laws = items; },
    broadcastRevolt: (active, incite, suppress) => { rec.revolt = { active, incite, suppress }; },
    broadcastMartial: (mode) => { rec.martial = { mode }; },
    broadcastFund: (amount, threshold) => { rec.fund = { amount, threshold }; },
  };
  return { deps, karma, rec };
}

describe('Governance 村長選挙 (§v1.3-C ⑥)', () => {
  it('任期締切で最多得票が村長になり、無料しきたり改定を任期1回使える', () => {
    const { deps, rec } = makeDeps({}, []);
    const gov = new Governance(makeConfig({ mayorPeriodMs: 1000 }), deps, 0);
    gov.voteMayor('u1', 'u2');
    gov.voteMayor('u3', 'u2');
    gov.voteMayor('u4', 'u1');
    gov.tick(1000); // 任期締切 → 集計
    expect(rec.mayor.userId).toBe('u2');
    expect(gov.isMayor('u2')).toBe(true);
    expect(gov.isMayor('u1')).toBe(false);
    expect(gov.tryMayorFreeRule('u2')).toBe(true); // 任期1回
    expect(gov.tryMayorFreeRule('u2')).toBe(false); // 2回目は不可
    expect(gov.tryMayorFreeRule('u1')).toBe(false); // 非村長は不可
  });

  it('投票が無ければ空位になる', () => {
    const { deps, rec } = makeDeps({}, []);
    const gov = new Governance(makeConfig({ mayorPeriodMs: 1000 }), deps, 0);
    gov.tick(1000);
    expect(rec.mayor.userId).toBeNull();
  });
});

describe('Governance 法案投票 (§v1.3-C ⑦)', () => {
  it('供託 → 賛成多数で可決し村ルール追加 + 供託返金', () => {
    const { deps, karma, rec } = makeDeps({ u1: 50 }, []);
    const gov = new Governance(makeConfig({ lawVoteMs: 1000 }), deps, 0);
    expect(gov.proposeLaw('u1', '広場で走るな', 0).ok).toBe(true);
    expect(karma.get('u1')).toBe(30); // 供託 20 を引いた
    gov.voteLaw('u2', 'law_1', true, 0);
    gov.voteLaw('u3', 'law_1', true, 0);
    gov.voteLaw('u4', 'law_1', false, 0);
    gov.tick(1000); // 締切 → 集計 (賛成2/反対1 → 可決)
    expect(rec.enacted).toEqual(['広場で走るな']);
    expect(karma.get('u1')).toBe(50); // 供託返金
    expect(rec.laws).toEqual([]); // 一覧から消える
  });

  it('否決なら供託没収・ルール追加なし', () => {
    const { deps, karma, rec } = makeDeps({ u1: 50 }, []);
    const gov = new Governance(makeConfig({ lawVoteMs: 1000 }), deps, 0);
    gov.proposeLaw('u1', '夜更かし禁止', 0);
    gov.voteLaw('u2', 'law_1', false, 0);
    gov.tick(1000);
    expect(rec.enacted).toEqual([]);
    expect(karma.get('u1')).toBe(30); // 没収のまま
  });

  it('供託カルマが足りなければ reject', () => {
    const { deps } = makeDeps({ u1: 5 }, []);
    const gov = new Governance(makeConfig(), deps, 0);
    const res = gov.proposeLaw('u1', 'むり', 0);
    expect(res.ok).toBe(false);
  });
});

describe('Governance 戒厳令 (§v1.3-C ⑨)', () => {
  it('集約カルマが martialCost に達したら発動', () => {
    const { deps, rec } = makeDeps({ u1: 100 }, []);
    const gov = new Governance(makeConfig(), deps, 0);
    for (let i = 0; i < 3; i += 1) expect(gov.martial('u1', 'freeze', 0).ok).toBe(true); // 75
    expect(rec.martials).toEqual([]); // まだ未達
    expect(gov.martial('u1', 'freeze', 0).ok).toBe(true); // 100 → 発動
    expect(rec.martials).toEqual([{ mode: 'freeze', days: 2 }]);
    expect(rec.martial.mode).toBe('freeze');
  });

  it('カルマ不足は reject', () => {
    const { deps } = makeDeps({ u1: 10 }, []);
    const gov = new Governance(makeConfig(), deps, 0);
    expect(gov.martial('u1', 'surge', 0).ok).toBe(false);
  });
});

describe('Governance 革命 (§v1.3-C ⑧)', () => {
  it('蜂起ウィンドウを開き、多い側が締切で勝つ', () => {
    const { deps, rec } = makeDeps({ u1: 100, u2: 100 }, []);
    const gov = new Governance(makeConfig({ revoltWindowMs: 1000 }), deps, 0);
    expect(gov.maybeStartRevolt(0.8, 0)).toBe(true); // 閾値 0.7 超
    expect(rec.revolt.active).toBe(true);
    gov.revolt('u1', 'incite', 0);
    gov.revolt('u1', 'incite', 0); // incite 20
    gov.revolt('u2', 'suppress', 0); // suppress 10
    gov.tick(1000); // 締切 → 決着
    expect(rec.revolts).toEqual(['incite']);
    expect(rec.revolt.active).toBe(false);
  });

  it('閾値以下では蜂起しない / 蜂起中でない revolt は reject', () => {
    const { deps } = makeDeps({ u1: 100 }, []);
    const gov = new Governance(makeConfig(), deps, 0);
    expect(gov.maybeStartRevolt(0.5, 0)).toBe(false);
    expect(gov.revolt('u1', 'incite', 0).ok).toBe(false);
  });
});

describe('Governance 税 + 村基金 (§v1.3-C ⑩)', () => {
  it('課税で残高分だけ徴収し、閾値到達で村イベント発火 + 基金リセット', () => {
    const { deps, karma, rec } = makeDeps({ u1: 100, u2: 100, u3: 100, u4: 100 }, ['u1', 'u2', 'u3', 'u4']);
    const gov = new Governance(makeConfig({ taxPeriodMs: 1000, taxAmount: 5, fundThreshold: 20 }), deps, 0);
    gov.tick(1000); // 4人 × 5 = 20 徴収 → fund 20 >= 20 → イベント + リセット
    expect(karma.get('u1')).toBe(95);
    expect(rec.funds).toEqual(['festival']); // 初回は祝祭
    expect(rec.fund).toEqual({ amount: 0, threshold: 20 }); // リセット後
  });

  it('残高が無いユーザからは取らない (部分徴収)', () => {
    const { deps, karma } = makeDeps({ u1: 3, u2: 0 }, ['u1', 'u2']);
    const gov = new Governance(makeConfig({ taxPeriodMs: 1000, taxAmount: 5, fundThreshold: HUGE }), deps, 0);
    gov.tick(1000);
    expect(karma.get('u1')).toBe(0); // 残高 3 だけ取られた
    expect(karma.get('u2')).toBe(0);
  });
});
