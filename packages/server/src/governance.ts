// 政治パック (§v1.3-C) の統治ロジックを集約する。村長選挙 / 法案投票 / 革命 / 戒厳令 / 税+村基金。
// 状態と時間管理 (任期・締切・徴収周期・蜂起ウィンドウ) を所有し、実際の世界・カルマ・broadcast への
// 反映は GovernanceDeps のコールバックへ委譲する (SRP: ここは集計と時間管理、副作用は index)。
//
// 無言フォールバック禁止 (RULE_CODE §7.1): 不正なコマンド (供託不足・対象不正・締切後等) は reject する。

import type { LawView, MartialMode } from '@pagus/sim';

/** 革命の陣営 (§v1.3-C ⑧)。 */
export type RevoltSide = 'incite' | 'suppress';
/** 村基金イベントの種別 (§v1.3-C ⑩)。 */
export type FundEventKind = 'festival' | 'relief';

/** コマンドの受理/却下 (握り潰さず理由を返す)。 */
export type GovResult = { ok: true } | { ok: false; reason: string };

/** 政治パックの数値設定 (env 由来)。村長は §17 で sim 側 (村人選挙) へ移管。 */
export interface GovernanceConfig {
  lawDeposit: number;
  lawVoteMs: number;
  revoltThreshold: number;
  revoltStake: number;
  revoltWindowMs: number;
  martialStake: number;
  martialCost: number;
  martialDays: number;
  taxPeriodMs: number;
  taxAmount: number;
  fundThreshold: number;
}

/** 世界・カルマ・broadcast への副作用を index から注入する。 */
export interface GovernanceDeps {
  /** カルマを引く (供託/投入)。足りなければ false。 */
  spend(userId: string, amount: number): boolean;
  /** カルマを戻す (供託返金)。 */
  refund(userId: string, amount: number): void;
  /** amount を上限に徴収し、実徴収額を返す (残高分だけ, §v1.3-C ⑩)。 */
  take(userId: string, amount: number): number;
  /** 徴収/返金後に本人へ状態 push する。 */
  pushState(userId: string): void;
  /** 集計母集団の全 userId (税の徴収対象)。 */
  knownUserIds(): string[];
  /** 法案可決 → 村ルール追加。追加できたら true (§v1.3-C ⑦)。 */
  enactLaw(text: string): boolean;
  /** 革命の決着を世界の評判へ反映する (§v1.3-C ⑧)。 */
  applyRevolt(side: RevoltSide): void;
  /** 戒厳令を発動する (sim フックへ, §v1.3-C ⑨)。 */
  activateMartial(mode: MartialMode, days: number): void;
  /** 村基金イベントを発火する (§v1.3-C ⑩)。 */
  fundEvent(kind: FundEventKind): void;
  /** 村の歴史へ 1 行刻む。 */
  chronicle(text: string): void;
  /** 法案一覧 (⑦) を配る。 */
  broadcastLaws(items: LawView[]): void;
  /** 蜂起状態 (⑧) を配る。 */
  broadcastRevolt(active: boolean, incite: number, suppress: number, endsInMs: number): void;
  /** 戒厳令状態 (⑨) を配る。 */
  broadcastMartial(mode: MartialMode | null, endsInMs: number): void;
  /** 村基金残高 (⑩) を配る。 */
  broadcastFund(amount: number, threshold: number): void;
}

/** 投票中の法案 1 件 (内部状態)。 */
interface Law {
  id: string;
  text: string;
  proposer: string;
  deposit: number;
  /** userId → 賛成(true)/反対(false)。投票し直しで上書き。 */
  votes: Map<string, boolean>;
  endsAt: number;
}

export class Governance {
  // ⑦ 法案
  private readonly laws = new Map<string, Law>();
  private lawSeq = 0;

  // ⑧ 革命 (蜂起ウィンドウ)
  private revoltActive = false;
  private revoltEndsAt = 0;
  private inciteTotal = 0;
  private suppressTotal = 0;

  // ⑨ 戒厳令 (発動カルマの集約。mode ごとに別プール)
  private freezePool = 0;
  private surgePool = 0;

  // ⑩ 税 + 村基金
  private nextTaxAt: number;
  private fund = 0;
  /** 次の村基金イベントが祝祭(true)か救済(false)か (交互)。 */
  private nextFundFestival = true;

  constructor(
    private readonly cfg: GovernanceConfig,
    private readonly deps: GovernanceDeps,
    now: number,
  ) {
    this.nextTaxAt = now + cfg.taxPeriodMs;
  }

  // --- 初期配信 ------------------------------------------------------------------

  /** 現在の全政治状態を broadcast する (起動直後に ws へ現値を保持させる)。 */
  broadcastAll(now: number): void {
    this.deps.broadcastLaws(this.lawViews(now));
    this.deps.broadcastRevolt(this.revoltActive, this.inciteTotal, this.suppressTotal, Math.max(0, this.revoltEndsAt - now));
    this.deps.broadcastMartial(null, 0);
    this.deps.broadcastFund(this.fund, this.cfg.fundThreshold);
  }

  // --- ⑦ 法案投票 ----------------------------------------------------------------

  /** 法案を提案する (§v1.3-C ⑦)。供託カルマを払い、締切まで投票を受け付ける。 */
  proposeLaw(userId: string, text: string, now: number): GovResult {
    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > 40) return { ok: false, reason: '法案は1〜40文字' };
    if (!this.deps.spend(userId, this.cfg.lawDeposit)) return { ok: false, reason: 'カルマが足りない (供託)' };
    this.lawSeq += 1;
    const id = `law_${this.lawSeq}`;
    this.laws.set(id, {
      id,
      text: trimmed,
      proposer: userId,
      deposit: this.cfg.lawDeposit,
      votes: new Map(),
      endsAt: now + this.cfg.lawVoteMs,
    });
    this.deps.pushState(userId);
    this.deps.broadcastLaws(this.lawViews(now));
    return { ok: true };
  }

  /** 法案へ賛成/反対する (§v1.3-C ⑦)。各 userId 1 票、再投票で上書き。 */
  voteLaw(userId: string, lawId: string, approve: boolean, now: number): GovResult {
    const law = this.laws.get(lawId);
    if (!law) return { ok: false, reason: 'その法案は存在しない' };
    law.votes.set(userId, approve);
    this.deps.broadcastLaws(this.lawViews(now));
    return { ok: true };
  }

  /** 締切を迎えた法案を集計する。賛成多数で可決 (ルール追加 + 供託返金)、否決で供託没収。 */
  private resolveLaws(now: number): void {
    let changed = false;
    for (const law of [...this.laws.values()]) {
      if (now < law.endsAt) continue;
      let yes = 0;
      let no = 0;
      for (const approve of law.votes.values()) approve ? (yes += 1) : (no += 1);
      this.laws.delete(law.id);
      if (yes > no) {
        const added = this.deps.enactLaw(law.text);
        this.deps.refund(law.proposer, law.deposit);
        this.deps.pushState(law.proposer);
        this.deps.chronicle(
          added
            ? `🏛 法案可決: 「${law.text}」が掟になった (賛成${yes}/反対${no}, 供託返金)`
            : `🏛 法案可決: 「${law.text}」(しきたり上限で未追加, 供託返金)`,
        );
      } else {
        this.deps.chronicle(`🏛 法案否決: 「${law.text}」(賛成${yes}/反対${no}, 供託没収)`);
      }
      changed = true;
    }
    if (changed) this.deps.broadcastLaws(this.lawViews(now));
  }

  private lawViews(now: number): LawView[] {
    return [...this.laws.values()].map((l) => {
      let yes = 0;
      let no = 0;
      for (const approve of l.votes.values()) approve ? (yes += 1) : (no += 1);
      return { id: l.id, text: l.text, yes, no, endsInMs: Math.max(0, l.endsAt - now) };
    });
  }

  // --- ⑧ 革命 --------------------------------------------------------------------

  /** 日末に蜂起条件 (malice > 閾値) を満たせば蜂起ウィンドウを開く (§v1.3-C ⑧)。開いたら true。 */
  maybeStartRevolt(malice: number, now: number): boolean {
    if (this.revoltActive) return false;
    if (malice <= this.cfg.revoltThreshold) return false;
    this.revoltActive = true;
    this.revoltEndsAt = now + this.cfg.revoltWindowMs;
    this.inciteTotal = 0;
    this.suppressTotal = 0;
    this.deps.chronicle('🔥 革命: 村に不穏な空気が満ち、蜂起が始まった');
    this.deps.broadcastRevolt(true, 0, 0, this.cfg.revoltWindowMs);
    return true;
  }

  /** 蜂起にカルマを投じる (§v1.3-C ⑧)。incite/suppress に集約。蜂起中のみ。 */
  revolt(userId: string, side: RevoltSide, now: number): GovResult {
    if (!this.revoltActive) return { ok: false, reason: 'いまは蜂起していない' };
    if (!this.deps.spend(userId, this.cfg.revoltStake)) return { ok: false, reason: 'カルマが足りない' };
    if (side === 'incite') this.inciteTotal += this.cfg.revoltStake;
    else this.suppressTotal += this.cfg.revoltStake;
    this.deps.pushState(userId);
    this.deps.broadcastRevolt(true, this.inciteTotal, this.suppressTotal, Math.max(0, this.revoltEndsAt - now));
    return { ok: true };
  }

  /** 蜂起ウィンドウ締切で決着させる。多い側が勝ち (同数/無投票は suppress=鎮静)。 */
  private resolveRevolt(now: number): void {
    const side: RevoltSide = this.inciteTotal > this.suppressTotal ? 'incite' : 'suppress';
    this.deps.applyRevolt(side);
    this.deps.chronicle(
      side === 'incite'
        ? `🔥 革命: 扇動側が勝ち、村は荒廃へ傾いた (扇動${this.inciteTotal}/鎮圧${this.suppressTotal})`
        : `🔥 革命: 鎮圧側が勝ち、騒乱は鎮まった (扇動${this.inciteTotal}/鎮圧${this.suppressTotal})`,
    );
    this.revoltActive = false;
    this.inciteTotal = 0;
    this.suppressTotal = 0;
    this.revoltEndsAt = 0;
    this.deps.broadcastRevolt(false, 0, 0, 0);
  }

  // --- ⑨ 戒厳令 ------------------------------------------------------------------

  /** 戒厳令にカルマを投じる (§v1.3-C ⑨)。mode ごとの集約が cost に達したら発動。 */
  martial(userId: string, mode: MartialMode, now: number): GovResult {
    if (!this.deps.spend(userId, this.cfg.martialStake)) return { ok: false, reason: 'カルマが足りない' };
    if (mode === 'freeze') this.freezePool += this.cfg.martialStake;
    else this.surgePool += this.cfg.martialStake;
    this.deps.pushState(userId);
    const pool = mode === 'freeze' ? this.freezePool : this.surgePool;
    if (pool >= this.cfg.martialCost) {
      if (mode === 'freeze') this.freezePool = 0;
      else this.surgePool = 0;
      this.deps.activateMartial(mode, this.cfg.martialDays);
      this.deps.chronicle(
        mode === 'freeze'
          ? `🛡 戒厳令: 月次の災いを ${this.cfg.martialDays}日 凍結した`
          : `🛡 戒厳令: 取り締まりを強め事件が ${this.cfg.martialDays}日 多発する`,
      );
      this.deps.broadcastMartial(mode, 0);
    }
    return { ok: true };
  }

  // --- ⑩ 税 + 村基金 -------------------------------------------------------------

  /** 課税周期を回す。全 known ユーザから残高分だけ徴収し村基金へ。閾値到達で村イベント発火。 */
  private runTax(now: number): void {
    let collected = 0;
    for (const uid of this.deps.knownUserIds()) {
      const got = this.deps.take(uid, this.cfg.taxAmount);
      if (got > 0) {
        collected += got;
        this.deps.pushState(uid);
      }
    }
    this.nextTaxAt = now + this.cfg.taxPeriodMs;
    if (collected > 0) {
      this.fund += collected;
      this.deps.chronicle(`🏛 徴税: ${collected} カルマが村基金に集まった (計 ${Math.round(this.fund)})`);
    }
    if (this.fund >= this.cfg.fundThreshold) {
      const kind: FundEventKind = this.nextFundFestival ? 'festival' : 'relief';
      this.nextFundFestival = !this.nextFundFestival;
      this.deps.fundEvent(kind);
      this.deps.chronicle(
        kind === 'festival'
          ? '🎉 村基金: 祝祭が催され村に活気が満ちた'
          : '🎁 村基金: 救済が配られ住民の疲れが癒えた',
      );
      this.fund = 0;
    }
    this.deps.broadcastFund(this.fund, this.cfg.fundThreshold);
  }

  // --- tick ----------------------------------------------------------------------

  /** 周期処理 (index が setInterval で毎秒回す)。法案締切 / 蜂起決着 / 課税。 */
  tick(now: number): void {
    this.resolveLaws(now);
    if (this.revoltActive && now >= this.revoltEndsAt) this.resolveRevolt(now);
    if (now >= this.nextTaxAt) this.runTax(now);
  }
}
