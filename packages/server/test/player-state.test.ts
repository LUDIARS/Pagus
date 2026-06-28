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

  it('snapshot は karma/virtue/sanctionCost/canCheerInMs/championId を返す', () => {
    const ps = new PlayerState();
    ps.cheer('u', INTERVAL);
    const snap = ps.snapshot('u', INTERVAL);
    expect(snap.virtue).toBeCloseTo(0.05, 6);
    expect(snap.sanctionCost).toBeCloseTo(30 * 1.05, 6);
    expect(snap.canCheerInMs).toBe(INTERVAL);
    expect(snap.karma).toBe(0);
    expect(snap.championId).toBeNull();
  });
});

// env 既定: PAGUS_CHAMPION_KARMA_MULT=1.5 / PAGUS_CHAMPION_DEATH_PENALTY=20。
describe('PlayerState 推し指名 (§1 champion)', () => {
  it('setChampion / getChampion で推しを指名・差し替え・解除できる', () => {
    const ps = new PlayerState();
    expect(ps.getChampion('u')).toBeNull();
    ps.setChampion('u', 'v1');
    expect(ps.getChampion('u')).toBe('v1');
    ps.setChampion('u', 'v2'); // 差し替え
    expect(ps.getChampion('u')).toBe('v2');
    ps.setChampion('u', null); // 解除
    expect(ps.getChampion('u')).toBeNull();
  });

  it('usersWithChampion はその villager を推しにする全 userId を返す', () => {
    const ps = new PlayerState();
    ps.setChampion('a', 'v1');
    ps.setChampion('b', 'v1');
    ps.setChampion('c', 'v2');
    expect(ps.usersWithChampion('v1').sort()).toEqual(['a', 'b']);
    expect(ps.usersWithChampion('v2')).toEqual(['c']);
    expect(ps.usersWithChampion('v9')).toEqual([]);
  });

  it('accrue は championAlive===true のユーザだけ ×CHAMPION_KARMA_MULT する', () => {
    const ps = new PlayerState();
    ps.setChampion('boosted', 'v1'); // 生きてる推し
    ps.setChampion('plain', 'v2'); // 死んでる推し → 倍率なし
    ps.get('none'); // 推しなし
    ps.accrue(0); // 基準
    ps.accrue(10_000, (uid) => uid === 'boosted'); // +0.5×10=5、boosted は ×1.5=7.5
    expect(ps.get('boosted').karma).toBeCloseTo(7.5, 6);
    expect(ps.get('plain').karma).toBeCloseTo(5, 6);
    expect(ps.get('none').karma).toBeCloseTo(5, 6);
  });

  it('accrue は championAlive 未指定なら倍率なし (後方互換)', () => {
    const ps = new PlayerState();
    ps.setChampion('u', 'v1');
    ps.accrue(0);
    ps.accrue(10_000);
    expect(ps.get('u').karma).toBeCloseTo(5, 6);
  });

  it('onChampionDeath はカルマを penalty 分削り (下限0) 推しを解除する', () => {
    const ps = new PlayerState();
    ps.setChampion('u', 'v1');
    ps.accrue(0);
    ps.accrue(100_000); // +0.5×100=50 → 50 (max100 未満)
    expect(ps.get('u').karma).toBeCloseTo(50, 6);
    ps.onChampionDeath('u'); // -20
    expect(ps.get('u').karma).toBeCloseTo(30, 6);
    expect(ps.getChampion('u')).toBeNull(); // 解除

    // カルマが penalty 未満でも下限0でクランプ。
    const ps2 = new PlayerState();
    ps2.setChampion('x', 'v1');
    ps2.accrue(0);
    ps2.accrue(10_000); // +5
    ps2.onChampionDeath('x');
    expect(ps2.get('x').karma).toBe(0);
  });
});

describe('PlayerState 称号 (§4.2 titles)', () => {
  it('称号は項目ごとの最大保持者に与え、0 件には付与しない', () => {
    const ps = new PlayerState();
    ps.bumpStat('a', 'incites', 3);
    ps.bumpStat('b', 'incites', 1);
    ps.bumpStat('b', 'sanctions', 5);
    const titles = ps.titles();
    expect(titles.get('a')).toBe('破壊神'); // incites 最多
    expect(titles.get('b')).toBe('審判者'); // sanctions 最多 (incites では a に負ける)
  });

  it('主称号は自分が保持する称号のうち件数最大の 1 つ', () => {
    const ps = new PlayerState();
    ps.bumpStat('u', 'incites', 3); // 破壊神 (3)
    ps.bumpStat('u', 'cheers', 5); // 聖人 (5)
    // 両方の最大保持者だが、件数最大の 聖人 を主称号に。
    expect(ps.titles().get('u')).toBe('聖人');
  });

  it('最大保持者の同点は userId 昇順で先勝ち', () => {
    const ps = new PlayerState();
    ps.bumpStat('z', 'betsWon', 2);
    ps.bumpStat('a', 'betsWon', 2);
    const titles = ps.titles();
    expect(titles.get('a')).toBe('博徒'); // 同点 → 昇順で a
    expect(titles.get('z')).toBeNull();
  });

  it('実績ゼロのユーザは称号なし (null)', () => {
    const ps = new PlayerState();
    ps.get('idle');
    expect(ps.titles().get('idle')).toBeNull();
  });
});

// env 既定: PAGUS_CARD_COOLDOWN_MS=60000。
describe('PlayerState カード介入クールダウン (§v1.3-A)', () => {
  it('canUseCard は未使用なら true、markCard 後はクールダウン中 false、経過後 true', () => {
    const ps = new PlayerState();
    const t0 = 1_000_000;
    expect(ps.canUseCard('u', t0)).toBe(true); // 未使用
    ps.markCard('u', t0);
    expect(ps.canUseCard('u', t0)).toBe(false); // 直後
    expect(ps.canUseCard('u', t0 + 59_999)).toBe(false); // クールダウン中
    expect(ps.canUseCard('u', t0 + 60_000)).toBe(true); // 経過 (>=)
  });

  it('cardCooldownInMs は残り時間を返す (0 = いま可能)', () => {
    const ps = new PlayerState();
    const t0 = 1_000_000;
    expect(ps.cardCooldownInMs('u', t0)).toBe(0); // 未使用
    ps.markCard('u', t0);
    expect(ps.cardCooldownInMs('u', t0 + 20_000)).toBe(40_000);
    expect(ps.cardCooldownInMs('u', t0 + 60_000)).toBe(0);
  });

  it('クールダウンは userId ごとに独立', () => {
    const ps = new PlayerState();
    const t0 = 1_000_000;
    ps.markCard('a', t0);
    expect(ps.canUseCard('a', t0 + 1)).toBe(false);
    expect(ps.canUseCard('b', t0 + 1)).toBe(true); // 別ユーザは影響なし
  });
});

// env 既定: PAGUS_TRANSFER_FEE_PCT=0。
describe('PlayerState 送金 (§v1.3-B ① transfer)', () => {
  it('残高内なら from→to へ移し、手数料0で受取は満額', () => {
    const ps = new PlayerState();
    ps.addKarma('a', 50);
    expect(ps.transfer('a', 'b', 20)).toBe(true);
    expect(ps.get('a').karma).toBe(30);
    expect(ps.get('b').karma).toBe(20);
  });

  it('自分宛て / 非正 / 非整数 / 残高超過は false (無言フォールバック禁止)', () => {
    const ps = new PlayerState();
    ps.addKarma('a', 10);
    expect(ps.transfer('a', 'a', 5)).toBe(false); // 自分宛て
    expect(ps.transfer('a', 'b', 0)).toBe(false); // 非正
    expect(ps.transfer('a', 'b', 2.5)).toBe(false); // 非整数
    expect(ps.transfer('a', 'b', 11)).toBe(false); // 残高超過
    expect(ps.get('a').karma).toBe(10); // いずれも残高不変
  });
});

// env 既定: 利子率は呼び出し側 (index PAGUS_BANK_INTEREST=0.02) が渡す。
describe('PlayerState 銀行 (§v1.3-B ④ deposit/withdraw/interest)', () => {
  it('預入は karma→savings、引出は savings→karma に移す', () => {
    const ps = new PlayerState();
    ps.addKarma('u', 40);
    expect(ps.deposit('u', 30)).toBe(true);
    expect(ps.get('u').karma).toBe(10);
    expect(ps.savings('u')).toBe(30);
    // 預金は spend (操作の支払) 対象外。
    expect(ps.spend('u', 20)).toBe(false); // karma は 10 しかない
    expect(ps.withdraw('u', 25)).toBe(true);
    expect(ps.get('u').karma).toBe(35);
    expect(ps.savings('u')).toBe(5);
  });

  it('残高/預金を超える預入・引出は false', () => {
    const ps = new PlayerState();
    ps.addKarma('u', 10);
    expect(ps.deposit('u', 11)).toBe(false);
    ps.deposit('u', 10);
    expect(ps.withdraw('u', 11)).toBe(false);
  });

  it('applyInterest は預金に利子を付ける (savings ×= 1+rate)', () => {
    const ps = new PlayerState();
    ps.addKarma('u', 100);
    ps.deposit('u', 100);
    ps.applyInterest(0.02);
    expect(ps.savings('u')).toBeCloseTo(102, 6);
    expect(ps.get('u').karma).toBe(0); // karma には付かない
  });
});

// env 既定: 倍率は呼び出し側 (index PAGUS_INSURE_MULT=3) が渡す。
describe('PlayerState 推し保険 (§v1.3-B ③ insure/settle)', () => {
  it('死亡で premium×mult を払戻し契約を解除する', () => {
    const ps = new PlayerState();
    ps.insure('a', 'v1', 10, 5); // expireTerm=5
    ps.insure('b', 'v1', 4, 5);
    const payouts = ps.settleInsuranceForDeath('v1', 3);
    expect(payouts.sort((x, y) => x.userId.localeCompare(y.userId))).toEqual([
      { userId: 'a', villagerId: 'v1', payout: 30 },
      { userId: 'b', villagerId: 'v1', payout: 12 },
    ]);
    expect(ps.get('a').karma).toBe(30);
    expect(ps.get('b').karma).toBe(12);
    // 解除済み: 2 度目は払戻なし。
    expect(ps.settleInsuranceForDeath('v1', 3)).toEqual([]);
  });

  it('掛けていない villager の死は払戻なし', () => {
    const ps = new PlayerState();
    ps.insure('a', 'v1', 10, 5);
    expect(ps.settleInsuranceForDeath('v2', 3)).toEqual([]);
  });

  it('pruneExpiredInsurance は expireTerm < term の契約を掃除する', () => {
    const ps = new PlayerState();
    ps.insure('a', 'v1', 10, 4); // expireTerm 4
    ps.pruneExpiredInsurance(5); // 4 < 5 → 失効
    expect(ps.settleInsuranceForDeath('v1', 3)).toEqual([]); // もう契約なし
  });
});

describe('PlayerState snapshot に savings (§v1.3-B ④)', () => {
  it('snapshot は savings を含む', () => {
    const ps = new PlayerState();
    ps.addKarma('u', 20);
    ps.deposit('u', 15);
    expect(ps.snapshot('u', 0).savings).toBe(15);
  });
});

describe('PlayerState 二大陣営 (§4.3 faction)', () => {
  it('明示選択した陣営を返す', () => {
    const ps = new PlayerState();
    ps.setFaction('u', 'incite');
    expect(ps.factionOf('u')).toBe('incite');
    ps.setFaction('u', 'guide');
    expect(ps.factionOf('u')).toBe('guide');
  });

  it('未選択は行動から推定: cheers+rulesAdded >= incites+sanctions なら guide', () => {
    const ps = new PlayerState();
    // 善導寄り。
    ps.bumpStat('g', 'cheers', 2);
    ps.bumpStat('g', 'rulesAdded', 1);
    expect(ps.factionOf('g')).toBe('guide');
    // 扇動寄り。
    ps.bumpStat('i', 'incites', 3);
    ps.bumpStat('i', 'sanctions', 1);
    expect(ps.factionOf('i')).toBe('incite');
    // 同数 (0=0) は guide 寄り (>=)。
    expect(ps.factionOf('neutral')).toBe('guide');
  });

  it('明示選択は推定より優先される', () => {
    const ps = new PlayerState();
    ps.bumpStat('u', 'incites', 5); // 推定なら incite
    ps.setFaction('u', 'guide'); // 明示で guide
    expect(ps.factionOf('u')).toBe('guide');
  });
});
