// プレイヤーのカルマ/善性を userId ごとに管理する (§4.4)。
// カルマは時間経過で自動でたまり (accrue)、扇動/制裁で消費 (spend) する。
// 善性 (virtue) は応援で上がり、制裁コストを重くする。WS の per-connection 配信で使う。
//
// 設定不備の無言フォールバック禁止 (RULE_CODE §7.1): env が数値でなければ即エラー。

/** env を数値で読む。未設定は fallback、数値でなければ throw (無言フォールバック禁止)。 */
function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`環境変数 ${name} が数値ではありません: ${v}`);
  return n;
}

import type { PlayerStats, Faction, LeaderboardEntry } from '@pagus/sim';

interface PlayerEntry {
  karma: number;
  virtue: number;
  lastCheerMs: number;
  /** 推し (champion) の villager id。未指名は null (§1)。 */
  championId: string | null;
  /** 実績カウンタ (§4.1)。 */
  stats: PlayerStats;
  /** 明示選択した陣営 (§4.3)。未選択は null = 行動から推定。 */
  faction: Faction | null;
  /** 銀行預金 (§v1.3-B ④)。日末に利子が付き、spend (操作の支払) 対象外。 */
  savings: number;
  /** 累計課金額 (§v1.3-F 課金モック)。topup でカルマと共に増える。 */
  spent: number;
}

/** 推し保険の 1 契約 (§v1.3-B ③)。userId+villagerId をキーに保持。 */
interface InsuranceContract {
  premium: number;
  /** この term を超えたら失効 (日末に掃除)。 */
  expireTerm: number;
}

/** 称号の定義 (§4.2): 実績カウンタ → 称号名。最大保持者に与える。 */
const TITLE_CATEGORIES: { key: keyof PlayerStats; title: string }[] = [
  { key: 'incites', title: '破壊神' },
  { key: 'sanctions', title: '審判者' },
  { key: 'cheers', title: '聖人' },
  { key: 'rulesAdded', title: '立法者' },
  { key: 'betsWon', title: '博徒' },
];

function emptyStats(): PlayerStats {
  return { incites: 0, sanctions: 0, cheers: 0, rulesAdded: 0, betsWon: 0, championDeaths: 0 };
}

/** 保険清算 1 件 (§v1.3-B ③): どの userId にいくら払い戻すか。 */
export interface InsurancePayout {
  userId: string;
  villagerId: string;
  payout: number;
}

/** snapshot/配信に使う 1 ユーザの状態。 */
export interface PlayerStateSnapshot {
  karma: number;
  virtue: number;
  sanctionCost: number;
  canCheerInMs: number;
  /** 推し (champion) の villager id。未指名は null (§1)。 */
  championId: string | null;
  /** 銀行預金 (§v1.3-B ④)。 */
  savings: number;
  /** 累計課金額 (§v1.3-F 課金モック)。 */
  spent: number;
}

export class PlayerState {
  private readonly players = new Map<string, PlayerEntry>();
  /** 直近に accrue した時刻 (経過秒からカルマ増分を出す)。未 accrue は null。 */
  private lastAccrueMs: number | null = null;
  /** カード介入クールダウン (§v1.3-A): userId → 次に使える時刻 (ms)。未登録はいつでも可。 */
  private readonly cardReadyAt = new Map<string, number>();
  private readonly cardCooldownMs = numEnv('PAGUS_CARD_COOLDOWN_MS', 60000); // カード使用クールダウン

  private readonly rate = numEnv('PAGUS_KARMA_RATE', 0.5); // 毎秒のカルマ加算量
  private readonly max = numEnv('PAGUS_KARMA_MAX', 100); // カルマ上限
  private readonly inciteCost = numEnv('PAGUS_INCITE_COST', 10); // 扇動コスト
  private readonly sanctionBase = numEnv('PAGUS_SANCTION_COST', 30); // 制裁コスト基準
  private readonly virtueK = numEnv('PAGUS_SANCTION_VIRTUE_K', 1); // 善性による制裁コスト係数
  private readonly cheerInterval = numEnv('PAGUS_CHEER_INTERVAL_MS', 180000); // 応援インターバル
  private readonly cheerVirtue = numEnv('PAGUS_CHEER_VIRTUE', 0.05); // 応援1回の善性上昇
  private readonly championKarmaMult = numEnv('PAGUS_CHAMPION_KARMA_MULT', 1.5); // 推し生存中のカルマ加速倍率 (§1)
  private readonly championDeathPenalty = numEnv('PAGUS_CHAMPION_DEATH_PENALTY', 20); // 推しの死のカルマ罰 (§1)
  private readonly transferFeePct = numEnv('PAGUS_TRANSFER_FEE_PCT', 0); // 送金手数料 (%) (§v1.3-B ①)

  /** 推し保険の契約 (§v1.3-B ③): `${userId}:${villagerId}` → 契約。 */
  private readonly insurances = new Map<string, InsuranceContract>();
  /** 次の制裁が無料になるユーザ (§v1.3-B ② オークション sanction_free)。 */
  private readonly sanctionFreeUsers = new Set<string>();
  /** 次のカードのクールダウンを無視できるユーザ (§v1.3-B ② オークション card_grant)。 */
  private readonly cardGrantUsers = new Set<string>();

  /** 扇動の固定コスト。 */
  get inciteCostValue(): number {
    return this.inciteCost;
  }

  /** 無ければ既定値で作成して返す (stats 全0 / faction 未選択)。 */
  get(userId: string): PlayerEntry {
    let e = this.players.get(userId);
    if (!e) {
      e = { karma: 0, virtue: 0, lastCheerMs: 0, championId: null, stats: emptyStats(), faction: null, savings: 0, spent: 0 };
      this.players.set(userId, e);
    }
    return e;
  }

  /**
   * 全ユーザに経過秒ぶんの rate を足し、max でクランプする。server が 1 秒間隔で呼ぶ。
   * championAlive(userId)===true のユーザは加算を ×CHAMPION_KARMA_MULT する (§1, 推し生存中の加速)。
   * championAlive 未指定なら倍率なし (後方互換)。
   */
  accrue(now: number, championAlive?: (userId: string) => boolean): void {
    if (this.lastAccrueMs === null) {
      this.lastAccrueMs = now;
      return;
    }
    const elapsedSec = (now - this.lastAccrueMs) / 1000;
    this.lastAccrueMs = now;
    if (elapsedSec <= 0) return;
    const base = this.rate * elapsedSec;
    for (const [userId, e] of this.players) {
      // 課金 (topup) で max を超えている分は通常加算で削らない (据置, §v1.3-F)。
      if (e.karma >= this.max) continue;
      const gain = championAlive?.(userId) ? base * this.championKarmaMult : base;
      e.karma = Math.min(this.max, e.karma + gain);
    }
  }

  /**
   * 課金モック (§v1.3-F)。amount ぶんカルマと累計課金額を増やす。検証 (許可パック) は呼び出し側。
   * 課金分はカルマ上限 max を超えてよい (clamp しない)。
   */
  topup(userId: string, amount: number): void {
    const e = this.get(userId);
    e.karma += amount;
    e.spent += amount;
  }

  /** その userId の累計課金額 (§v1.3-F)。 */
  spent(userId: string): number {
    return this.get(userId).spent;
  }

  /** 推しを指名/差し替え/解除する (§1)。villagerId=null で解除。 */
  setChampion(userId: string, villagerId: string | null): void {
    this.get(userId).championId = villagerId;
  }

  /** その userId の推し villager id (未指名は null)。 */
  getChampion(userId: string): string | null {
    return this.get(userId).championId;
  }

  /** その villager を推しにしている全 userId を返す (死亡検知の弔い対象, §1)。 */
  usersWithChampion(villagerId: string): string[] {
    const out: string[] = [];
    for (const [userId, e] of this.players) {
      if (e.championId === villagerId) out.push(userId);
    }
    return out;
  }

  /** 推しの死 (§1)。カルマを penalty だけ削り (下限0)、推しを解除する。 */
  onChampionDeath(userId: string): void {
    const e = this.get(userId);
    e.karma = Math.max(0, e.karma - this.championDeathPenalty);
    e.championId = null;
  }

  /** いま制裁に必要なカルマ (善性が高いほど重い, §4.4)。 */
  sanctionCost(userId: string): number {
    const e = this.get(userId);
    return this.sanctionBase * (1 + e.virtue * this.virtueK);
  }

  /** カルマが足りれば cost を引いて true、足りなければ false。 */
  spend(userId: string, cost: number): boolean {
    const e = this.get(userId);
    if (e.karma < cost) return false;
    e.karma -= cost;
    return true;
  }

  /** 応援 (§4.5)。インターバルを過ぎていれば lastCheer 更新 + 善性加算して true。 */
  cheer(userId: string, now: number): boolean {
    const e = this.get(userId);
    if (now - e.lastCheerMs < this.cheerInterval) return false;
    e.lastCheerMs = now;
    e.virtue = Math.min(1, e.virtue + this.cheerVirtue);
    return true;
  }

  /** 次に応援できるまでの残りミリ秒 (0 = いま可能)。 */
  canCheerInMs(userId: string, now: number): number {
    const e = this.get(userId);
    return Math.max(0, this.cheerInterval - (now - e.lastCheerMs));
  }

  /** カード介入が使えるか (§v1.3-A クールダウン)。未使用 or クールダウン経過で true。 */
  canUseCard(userId: string, now: number): boolean {
    return now >= (this.cardReadyAt.get(userId) ?? 0);
  }

  /** カード介入を 1 回使ったとして次回可能時刻を記録する (§v1.3-A)。 */
  markCard(userId: string, now: number): void {
    this.cardReadyAt.set(userId, now + this.cardCooldownMs);
  }

  /** 次にカードを使えるまでの残りミリ秒 (0 = いま可能, §v1.3-A)。 */
  cardCooldownInMs(userId: string, now: number): number {
    return Math.max(0, (this.cardReadyAt.get(userId) ?? 0) - now);
  }

  /** カルマを加算する (ベット払い戻し, §3)。下限0。払い戻しは上限 max を超過してよい。 */
  addKarma(userId: string, amount: number): void {
    const e = this.get(userId);
    e.karma = Math.max(0, e.karma + amount);
  }

  /** 善性を加算する (§v1.3-B ② オークション virtue_boost)。0..1 にクランプ。 */
  addVirtue(userId: string, amount: number): void {
    const e = this.get(userId);
    e.virtue = Math.min(1, Math.max(0, e.virtue + amount));
  }

  // --- 経済パック (§v1.3-B) -----------------------------------------------------

  /**
   * 送金 (§v1.3-B ①)。from→to へ amount カルマを移す。
   * from≠to / amount は正の整数 / from の残高内、を満たさなければ false (無言フォールバック禁止)。
   * 手数料 transferFeePct(%) は焼却 (受取額 = amount × (1 - pct/100), 端数切り捨て)。
   */
  transfer(from: string, to: string, amount: number): boolean {
    if (from === to) return false;
    if (!Number.isInteger(amount) || amount <= 0) return false;
    const sender = this.get(from);
    if (sender.karma < amount) return false;
    const received = Math.floor(amount * (1 - this.transferFeePct / 100));
    sender.karma -= amount;
    this.get(to).karma += received;
    return true;
  }

  /** 銀行へ預入 (§v1.3-B ④)。amount は正の整数かつカルマ残高内。預金は spend 対象外。 */
  deposit(userId: string, amount: number): boolean {
    if (!Number.isInteger(amount) || amount <= 0) return false;
    const e = this.get(userId);
    if (e.karma < amount) return false;
    e.karma -= amount;
    e.savings += amount;
    return true;
  }

  /** 銀行から引出 (§v1.3-B ④)。amount は正の整数かつ預金残高内。 */
  withdraw(userId: string, amount: number): boolean {
    if (!Number.isInteger(amount) || amount <= 0) return false;
    const e = this.get(userId);
    if (e.savings < amount) return false;
    e.savings -= amount;
    e.karma += amount;
    return true;
  }

  /** 全ユーザの預金に利子を付ける (§v1.3-B ④, 日末)。savings ×= (1 + rate)。 */
  applyInterest(rate: number): void {
    for (const e of this.players.values()) {
      if (e.savings > 0) e.savings *= 1 + rate;
    }
  }

  /** その userId の預金 (§v1.3-B ④)。 */
  savings(userId: string): number {
    return this.get(userId).savings;
  }

  /**
   * 推し保険を掛ける (§v1.3-B ③)。userId が villagerId に premium を掛け、expireTerm まで有効。
   * 既契約があれば上書き (premium と期限を更新)。amount 検証は呼び出し側 (spend 前)。
   */
  insure(userId: string, villagerId: string, premium: number, expireTerm: number): void {
    this.insurances.set(`${userId}:${villagerId}`, { premium, expireTerm });
  }

  /**
   * villagerId の死亡で保険を清算する (§v1.3-B ③)。その villager に掛けられた全契約を払戻し
   * (払戻 = premium × mult を addKarma) 契約を解除する。払戻一覧を返す (chronicle 用)。
   */
  settleInsuranceForDeath(villagerId: string, mult: number): InsurancePayout[] {
    const out: InsurancePayout[] = [];
    const suffix = `:${villagerId}`;
    for (const [key, contract] of this.insurances) {
      if (!key.endsWith(suffix)) continue;
      const userId = key.slice(0, key.length - suffix.length);
      const payout = Math.floor(contract.premium * mult);
      this.addKarma(userId, payout);
      out.push({ userId, villagerId, payout });
      this.insurances.delete(key);
    }
    return out;
  }

  /** 失効した保険契約を掃除する (§v1.3-B ③, 日末)。expireTerm < term を除去。 */
  pruneExpiredInsurance(term: number): void {
    for (const [key, contract] of this.insurances) {
      if (contract.expireTerm < term) this.insurances.delete(key);
    }
  }

  /** 次の制裁を無料にするフラグを付与する (§v1.3-B ② sanction_free)。 */
  grantSanctionFree(userId: string): void {
    this.sanctionFreeUsers.add(userId);
  }

  /** 制裁無料フラグがあれば消費して true (1 回限り, §v1.3-B ②)。 */
  consumeSanctionFree(userId: string): boolean {
    return this.sanctionFreeUsers.delete(userId);
  }

  /** 次のカードのクールダウンを無視するフラグを付与する (§v1.3-B ② card_grant)。 */
  grantCardFree(userId: string): void {
    this.cardGrantUsers.add(userId);
  }

  /** カード無料フラグがあれば消費して true (1 回限り, §v1.3-B ②)。 */
  consumeCardFree(userId: string): boolean {
    return this.cardGrantUsers.delete(userId);
  }

  /** 実績カウンタを増やす (§4.1)。 */
  bumpStat(userId: string, key: keyof PlayerStats, by = 1): void {
    this.get(userId).stats[key] += by;
  }

  /** 実績カウンタの写し (§4.1)。 */
  getStats(userId: string): PlayerStats {
    return { ...this.get(userId).stats };
  }

  /** 陣営を明示選択する (§4.3)。 */
  setFaction(userId: string, side: Faction): void {
    this.get(userId).faction = side;
  }

  /**
   * 陣営 (§4.3)。明示選択があればそれ、無ければ行動から推定:
   * cheers+rulesAdded >= incites+sanctions → 善導(guide)、else 扇動(incite)。
   */
  factionOf(userId: string): Faction {
    const e = this.get(userId);
    if (e.faction !== null) return e.faction;
    const s = e.stats;
    return s.cheers + s.rulesAdded >= s.incites + s.sanctions ? 'guide' : 'incite';
  }

  /** 登録済みの全 userId。 */
  userIds(): string[] {
    return [...this.players.keys()];
  }

  /**
   * 各ユーザの主称号 (§4.2)。称号は項目ごとの最大保持者 (>0、同点は userId 昇順) に与え、
   * 各ユーザは自分が保持する称号のうち件数最大のものを 1 つ主称号とする (保持なしは null)。
   */
  titles(): Map<string, string | null> {
    const ids = this.userIds().sort(); // 同点は userId 昇順で先勝ち
    // 称号 → { 保持者 userId, 件数 }
    const holder = new Map<string, { user: string; value: number }>();
    for (const cat of TITLE_CATEGORIES) {
      let best: { user: string; value: number } | null = null;
      for (const uid of ids) {
        const v = this.get(uid).stats[cat.key];
        if (v <= 0) continue;
        if (!best || v > best.value) best = { user: uid, value: v }; // 厳密 > なので同点は先 (昇順) 勝ち
      }
      if (best) holder.set(cat.title, best);
    }
    const out = new Map<string, string | null>();
    for (const uid of ids) {
      let chosen: { title: string; value: number } | null = null;
      for (const cat of TITLE_CATEGORIES) {
        const h = holder.get(cat.title);
        if (!h || h.user !== uid) continue;
        if (!chosen || h.value > chosen.value) chosen = { title: cat.title, value: h.value };
      }
      out.set(uid, chosen ? chosen.title : null);
    }
    return out;
  }

  /** リーダーボード行を組む (§4.3)。title/faction/stats を埋める。 */
  leaderboard(): LeaderboardEntry[] {
    const titles = this.titles();
    return this.userIds().map((uid) => {
      const e = this.get(uid);
      return {
        userId: uid,
        title: titles.get(uid) ?? null,
        faction: this.factionOf(uid),
        karma: e.karma,
        virtue: e.virtue,
        stats: { ...e.stats },
        spent: e.spent,
      };
    });
  }

  /** 配信用の状態スナップショット。 */
  snapshot(userId: string, now: number): PlayerStateSnapshot {
    const e = this.get(userId);
    return {
      karma: e.karma,
      virtue: e.virtue,
      sanctionCost: this.sanctionCost(userId),
      canCheerInMs: this.canCheerInMs(userId, now),
      championId: e.championId,
      savings: e.savings,
      spent: e.spent,
    };
  }
}
