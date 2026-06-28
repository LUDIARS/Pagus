// オークション (§v1.3-B ②)。固定ロット3種をローテし、PAGUS_AUCTION_PERIOD_MS ごとに締め切る。
// オープン入札 (増額のみ・最高額更新)。入札時はカルマを徴収せず、締切時に最高入札者からのみ徴収する
// (hold しない方式で簡素化)。効果付与とカルマ徴収は index のコールバックが行う (SRP: ここは入札と時間管理)。
//
// 無言フォールバック禁止 (RULE_CODE §7.1): 不正な入札 (別ロット/減額/締切後) は reject する。

import type { AuctionLotView } from '@pagus/sim';

/** オークションの効果種別 (§v1.3-B ②)。 */
export type AuctionEffect = 'sanction_free' | 'virtue_boost' | 'card_grant';

/** ロット 1 種の定義 (固定ロット)。 */
interface LotDef {
  effect: AuctionEffect;
  title: string;
}

/** 固定ロット3種をローテする (§v1.3-B ②)。 */
const LOTS: readonly LotDef[] = [
  { effect: 'sanction_free', title: '制裁無料券 (次の制裁が無料)' },
  { effect: 'virtue_boost', title: '善性のお守り (善性 +0.1)' },
  { effect: 'card_grant', title: 'カード招待状 (次のカードのクールダウン無視)' },
];

/** bid() の結果。不正は ok:false で理由を返す (握り潰さない)。 */
export type BidResult = { ok: true } | { ok: false; reason: string };

/** 落札確定のコールバック。index が effect を付与しカルマを徴収する。 */
export type AuctionSettle = (effect: AuctionEffect, lotId: string, winnerUserId: string, amount: number) => void;

export class AuctionManager {
  private idx = 0;
  private highBid = 0;
  private highUserId: string | null = null;
  private endsAt: number;

  constructor(
    private readonly periodMs: number,
    now: number,
    private readonly onSettle: AuctionSettle,
    /** ロット状態が変わったら呼ぶ (broadcast 用)。 */
    private readonly onChange: () => void,
  ) {
    this.endsAt = now + periodMs;
  }

  /** 現アクティブロット。 */
  private get currentLot(): LotDef {
    const lot = LOTS[this.idx];
    if (!lot) throw new Error(`auction: 不正なロット index ${this.idx}`);
    return lot;
  }

  /**
   * 入札 (§v1.3-B ②)。lotId は現ロット一致 / 締切前 / amount は正の整数かつ現最高額より大、
   * を満たすときのみ受理。カルマ徴収はしない (落札時のみ)。受理で最高額を更新し onChange。
   */
  bid(lotId: string, userId: string, amount: number, now: number): BidResult {
    if (now >= this.endsAt) return { ok: false, reason: 'このロットは締め切られた' };
    if (lotId !== this.currentLot.effect) return { ok: false, reason: 'そのロットは現在出品されていない' };
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: '入札額は正の整数' };
    if (amount <= this.highBid) {
      return { ok: false, reason: `現在の最高額 (${this.highBid}) より高く入札してください` };
    }
    this.highBid = amount;
    this.highUserId = userId;
    this.onChange();
    return { ok: true };
  }

  /**
   * 締切判定 (§v1.3-B ②)。index が setInterval で回す。endsAt を過ぎていたら、
   * 最高入札者がいれば落札 (onSettle) し、次ロットへローテして新たな締切を張る。
   */
  tick(now: number): void {
    if (now < this.endsAt) return;
    const lot = this.currentLot;
    if (this.highUserId !== null && this.highBid > 0) {
      this.onSettle(lot.effect, lot.effect, this.highUserId, this.highBid);
    }
    this.idx = (this.idx + 1) % LOTS.length;
    this.highBid = 0;
    this.highUserId = null;
    this.endsAt = now + this.periodMs;
    this.onChange();
  }

  /** 配信用のロット状態 (現アクティブロット 1 件)。 */
  view(now: number): AuctionLotView[] {
    const lot = this.currentLot;
    return [
      {
        id: lot.effect,
        title: lot.title,
        highBid: this.highBid,
        highUserId: this.highUserId,
        endsInMs: Math.max(0, this.endsAt - now),
      },
    ];
  }
}
