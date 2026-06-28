// 裁判ベット (§3) のプール。現裁判 (incidentId) ごとに死刑/教育の賭けを保持し、
// パリミュチュエル方式で清算する。1 裁判 = 1 incidentId。新しい incidentId へ移ったら
// プールをリセットする (前 incidentId は決済済のはず)。
//
// 無言フォールバック禁止 (RULE_CODE §7.1): 不正な賭け (別 pick への乗り換え) は reject する。

/** 賭け先 (死刑 / 教育)。 */
export type BetPick = 'death' | 'educate';

/** place() の結果。乗り換え等の不正は ok:false で理由を返す (握り潰さない)。 */
export type PlaceResult = { ok: true } | { ok: false; reason: string };

/** settle() の結果。payouts = userId→払い戻しカルマ、winners = 勝者 (不成立返金時は空)。 */
export interface Settlement {
  payouts: Map<string, number>;
  winners: string[];
  /** 片側が空で不成立 → 全額返金したか。 */
  refunded: boolean;
}

export class BetPool {
  /** 現在のプールが対象とする裁判 incidentId (未開始は null)。 */
  private incidentId: string | null = null;
  private readonly death = new Map<string, number>();
  private readonly educate = new Map<string, number>();

  /** 現在プールが対象とする incidentId。 */
  get currentIncidentId(): string | null {
    return this.incidentId;
  }

  /** incidentId が変われば空にリセットして移行する (同一なら何もしない)。 */
  ensure(incidentId: string): void {
    if (this.incidentId === incidentId) return;
    this.incidentId = incidentId;
    this.death.clear();
    this.educate.clear();
  }

  private side(pick: BetPick): Map<string, number> {
    return pick === 'death' ? this.death : this.educate;
  }

  /**
   * 賭けを置く (§3)。incidentId が変われば自動でプールを切り替える。
   * 既存の賭けがあれば同 pick への増額のみ可。別 pick への乗り換えは reject。
   * amount は正の数前提 (検証は呼び出し側のカルマチェックで実施)。
   */
  place(incidentId: string, userId: string, pick: BetPick, amount: number): PlaceResult {
    this.ensure(incidentId);
    if (amount <= 0) return { ok: false, reason: '賭け金は正の数' };
    const existing = this.yourBet(userId);
    if (existing && existing.pick !== pick) {
      return { ok: false, reason: '別の選択肢には乗り換えできない (増額のみ可)' };
    }
    const m = this.side(pick);
    m.set(userId, (m.get(userId) ?? 0) + amount);
    return { ok: true };
  }

  /** 死刑/教育それぞれの総額。 */
  totals(): { death: number; educate: number } {
    return { death: sum(this.death), educate: sum(this.educate) };
  }

  /** そのユーザの現在の賭け (未賭けは null)。同一ユーザは片側にしか賭けられない。 */
  yourBet(userId: string): { pick: BetPick; amount: number } | null {
    const d = this.death.get(userId);
    if (d !== undefined) return { pick: 'death', amount: d };
    const e = this.educate.get(userId);
    if (e !== undefined) return { pick: 'educate', amount: e };
    return null;
  }

  /**
   * パリミュチュエル清算 (§3)。verdictWins = 勝ち側。
   * 勝ち側の各ユーザへ「自分の賭け金 + 負け側総額 × (自分の賭け金 / 勝ち側総額)」を払い戻す (端数切り捨て)。
   * 片側が空なら不成立 → 全員へ賭け金を全額返金。清算後はプールを空にする。
   */
  settle(verdictWins: BetPick): Settlement {
    const winMap = this.side(verdictWins);
    const loseMap = this.side(verdictWins === 'death' ? 'educate' : 'death');
    const winTotal = sum(winMap);
    const loseTotal = sum(loseMap);
    const payouts = new Map<string, number>();
    const winners: string[] = [];

    if (winTotal === 0 || loseTotal === 0) {
      // 不成立: 両側に賭けた全員へ自分の賭け金を返す。
      for (const [uid, amt] of winMap) payouts.set(uid, amt);
      for (const [uid, amt] of loseMap) payouts.set(uid, amt);
      this.clearBets();
      return { payouts, winners, refunded: true };
    }

    for (const [uid, stake] of winMap) {
      const share = Math.floor((loseTotal * stake) / winTotal); // 端数は捨て (§7)
      payouts.set(uid, stake + share);
      winners.push(uid);
    }
    this.clearBets();
    return { payouts, winners, refunded: false };
  }

  private clearBets(): void {
    this.death.clear();
    this.educate.clear();
  }
}

function sum(m: Map<string, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}
