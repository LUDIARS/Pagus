// 演出・協力パック (§v1.3-D) のロジックを集約する。
//   ㉑ ハイライト (節目バッファ) / ㉓ 予測アワード / ㉔ 月間MVP / ㉕ 観客の祈り / ㉚ シーズン制。
//   ㉙ 共闘レイドは状態と時間管理が独立するため RaidManager に分ける。
// いずれも状態と集計を所有し、世界・カルマ・broadcast への副作用は deps へ委譲する (SRP)。
//
// 無言フォールバック禁止 (RULE_CODE §7.1): 不正/受付外のコマンドは reason 付きで reject する。
// シーズン保存 (seasons.json) は try/catch で握り潰さず console.error する。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { HighlightCard, LeaderboardEntry, SeasonWinner, ChronicleKind } from '@pagus/sim';
import { dataDir } from './load-data.js';

/** コマンドの受理/却下 (握り潰さず理由を返す)。 */
export type SpectacleResult = { ok: true } | { ok: false; reason: string };

/** 予測的中の払い出し 1 件 (§v1.3-D ㉓)。 */
export interface PredictPayout {
  userId: string;
  reward: number;
}

/** 月間MVP の集計結果 (§v1.3-D ㉔)。 */
export interface MvpResult {
  villagerId: string;
  votes: number;
}

/** 観客の祈りの結果 (§v1.3-D ㉕)。fired=村バフ発火。count=現ウィンドウ内の祈った人数。 */
export interface PrayResult {
  fired: boolean;
  count: number;
}

/** シーズン確定 1 件 (§v1.3-D ㉚, seasons.json へ追記)。 */
export interface SeasonRecord {
  number: number;
  winner: SeasonWinner;
  /** 確定時刻 (ISO 文字列)。 */
  endedAt: string;
  leaderboard: LeaderboardEntry[];
}

/** シーズン確定の戻り (index がログ/broadcast に使う)。 */
export interface SeasonResult {
  number: number;
  winner: SeasonWinner;
  leaderboard: LeaderboardEntry[];
}

/** 演出・協力パックの数値設定 (env 由来)。 */
export interface SpectacleConfig {
  predictReward: number;
  prayWindowMs: number;
  prayNeeded: number;
  seasonMonths: number;
  seasonReward: number;
}

/** 世界・カルマ・broadcast・永続化への副作用を index から注入する。 */
export interface SpectacleDeps {
  /** カルマを加算する (予測的中報酬 / シーズン報酬)。 */
  addKarma(userId: string, amount: number): void;
  /** 加算後に本人へ状態 push する。 */
  pushState(userId: string): void;
  /** 集計母集団の全 userId。 */
  knownUserIds(): string[];
  /** その userId の陣営 (シーズン報酬の対象判定)。 */
  factionOf(userId: string): 'guide' | 'incite';
  /** 村の評判スコア (シーズン勝敗判定の素材)。 */
  reputation(): { benevolence: number; malice: number; order: number };
  /** リーダーボードのスナップ (シーズン保存/配信用)。 */
  buildLeaderboard(): LeaderboardEntry[];
  /** ハイライト一覧 (㉑) を配る。 */
  broadcastHighlights(cards: HighlightCard[]): void;
  /** シーズン確定 (㉚) を配る。 */
  broadcastSeason(number: number, winner: SeasonWinner, leaderboard: LeaderboardEntry[]): void;
  /** シーズン記録を seasons.json へ追記する (失敗は console.error)。 */
  persistSeason(record: SeasonRecord): void;
}

/** ハイライトバッファの上限 (§v1.3-D ㉑)。 */
const HIGHLIGHTS_CAP = 30;

export class SpectacleManager {
  // ㉑ ハイライト
  private readonly cards: HighlightCard[] = [];

  // ㉓ 予測アワード: userId → 予測した日。月内 1 予測 (上書き)。発生で resolved。
  private readonly predictions = new Map<string, number>();
  private predictionsResolved = false;

  // ㉔ 月間MVP: userId → 投票した villagerId。月内 1 票 (上書き)。
  private readonly mvpVotes = new Map<string, string>();

  // ㉕ 観客の祈り: userId → 直近に祈った時刻 (ウィンドウ判定)。
  private readonly prayers = new Map<string, number>();

  // ㉚ シーズン
  private seasonNumber = 1;
  private monthsIntoSeason = 0;

  constructor(
    private readonly cfg: SpectacleConfig,
    private readonly deps: SpectacleDeps,
  ) {}

  // --- ㉑ ハイライト --------------------------------------------------------------

  /** 節目をハイライトバッファに積み (上限30)、全クライアントへ配る (§v1.3-D ㉑)。 */
  recordHighlight(date: string, title: string, kind: ChronicleKind, summary: string): void {
    this.cards.push({ date, title, kind, summary });
    if (this.cards.length > HIGHLIGHTS_CAP) this.cards.splice(0, this.cards.length - HIGHLIGHTS_CAP);
    this.deps.broadcastHighlights(this.cards);
  }

  /** 現在のハイライト一覧 (接続時の初期配信用)。 */
  highlights(): HighlightCard[] {
    return [...this.cards];
  }

  // --- ㉓ 予測アワード ------------------------------------------------------------

  /**
   * 今月の事件発生日を予測する (§v1.3-D ㉓)。dayOfMonth は [1, daysInMonth] の整数。
   * 1 ユーザ 1 予測/月 (上書き可)。受付可否 (発生前か) は index が gate する。
   */
  predict(userId: string, dayOfMonth: number, daysInMonth: number): SpectacleResult {
    if (this.predictionsResolved) return { ok: false, reason: '今月の事件はもう発生した' };
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > daysInMonth) {
      return { ok: false, reason: `予測日は 1〜${daysInMonth} の整数` };
    }
    this.predictions.set(userId, dayOfMonth);
    return { ok: true };
  }

  /**
   * 事件発生日に予測を判定する (§v1.3-D ㉓)。actualDay と一致したユーザへ報酬カルマを配る。
   * 1 月 1 回だけ判定する (idempotent)。払い出し一覧を返す (chronicle 用)。
   */
  resolvePredictions(actualDay: number): PredictPayout[] {
    if (this.predictionsResolved) return [];
    this.predictionsResolved = true;
    const out: PredictPayout[] = [];
    for (const [userId, day] of this.predictions) {
      if (day !== actualDay) continue;
      this.deps.addKarma(userId, this.cfg.predictReward);
      this.deps.pushState(userId);
      out.push({ userId, reward: this.cfg.predictReward });
    }
    return out;
  }

  // --- ㉔ 月間MVP -----------------------------------------------------------------

  /**
   * 月間MVP に住民を投票する (§v1.3-D ㉔)。1 ユーザ 1 票/月 (上書き可)。
   * 対象が生存住民か (isAliveVillager) の検証は index 側で済ませ true を渡す。
   */
  voteMvp(userId: string, villagerId: string, isAliveVillager: boolean): SpectacleResult {
    if (!villagerId || villagerId.length === 0) return { ok: false, reason: 'MVP の対象が不正' };
    if (!isAliveVillager) return { ok: false, reason: 'MVP は生存どうぶつのみ' };
    this.mvpVotes.set(userId, villagerId);
    return { ok: true };
  }

  /**
   * 月替わりで MVP を集計する (§v1.3-D ㉔)。最多得票の villagerId (同票は villagerId 昇順)。
   * 票が無ければ null。集計後は票をリセットする。
   */
  resolveMvp(): MvpResult | null {
    if (this.mvpVotes.size === 0) return null;
    const counts = new Map<string, number>();
    for (const vid of this.mvpVotes.values()) counts.set(vid, (counts.get(vid) ?? 0) + 1);
    let winner: string | null = null;
    let best = 0;
    for (const [vid, c] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (c > best) {
        best = c;
        winner = vid;
      }
    }
    this.mvpVotes.clear();
    if (!winner) return null;
    return { villagerId: winner, votes: best };
  }

  // --- ㉕ 観客の祈り --------------------------------------------------------------

  /**
   * 観客の祈り (§v1.3-D ㉕, 無料)。ウィンドウ (prayWindowMs) 内に prayNeeded 人の異なる userId が
   * 祈ると村バフを発火する。発火したら fired=true を返し (バフ適用は index)、ウィンドウをリセットする。
   */
  pray(userId: string, now: number): PrayResult {
    // 期限切れの祈りを掃除する (異なる userId を Map で distinct に保つ)。
    for (const [uid, at] of this.prayers) {
      if (now - at > this.cfg.prayWindowMs) this.prayers.delete(uid);
    }
    this.prayers.set(userId, now);
    if (this.prayers.size >= this.cfg.prayNeeded) {
      this.prayers.clear();
      return { fired: true, count: this.cfg.prayNeeded };
    }
    return { fired: false, count: this.prayers.size };
  }

  // --- 月替わり / ㉚ シーズン ------------------------------------------------------

  /** 新しい月の予測受付を開く (§v1.3-D ㉓, 月替わりで index が呼ぶ)。 */
  resetMonth(): void {
    this.predictions.clear();
    this.predictionsResolved = false;
  }

  /**
   * 月替わりでシーズン境界を進める (§v1.3-D ㉚)。seasonMonths 月ごとに陣営勝敗を確定する。
   * guide=(善良+秩序) vs incite=悪辣 を比較し、勝利陣営の所属プレイヤーへ報酬カルマを配る。
   * シーズン番号を ++ し、ランキングを seasons.json へ追記し broadcast する。境界でなければ null。
   */
  advanceSeasonMonth(): SeasonResult | null {
    this.monthsIntoSeason += 1;
    if (this.monthsIntoSeason < this.cfg.seasonMonths) return null;
    this.monthsIntoSeason = 0;

    const rep = this.deps.reputation();
    const guideScore = rep.benevolence + rep.order;
    const inciteScore = rep.malice;
    const winner: SeasonWinner = guideScore > inciteScore ? 'guide' : inciteScore > guideScore ? 'incite' : 'draw';

    if (winner !== 'draw') {
      for (const uid of this.deps.knownUserIds()) {
        if (this.deps.factionOf(uid) !== winner) continue;
        this.deps.addKarma(uid, this.cfg.seasonReward);
        this.deps.pushState(uid);
      }
    }

    const number = this.seasonNumber;
    this.seasonNumber += 1;
    const leaderboard = this.deps.buildLeaderboard();
    this.deps.persistSeason({ number, winner, endedAt: new Date().toISOString(), leaderboard });
    this.deps.broadcastSeason(number, winner, leaderboard);
    return { number, winner, leaderboard };
  }

  /** 現在のシーズン番号 (UI/ログ用)。 */
  currentSeason(): number {
    return this.seasonNumber;
  }
}

// --- ㉙ 共闘レイド (RaidManager) -------------------------------------------------

/** 共闘レイドの数値設定 (env 由来)。 */
export interface RaidConfig {
  hp: number;
  windowMs: number;
  reward: number;
  chance: number;
}

/** レイドの世界・カルマ・broadcast への副作用を index から注入する。 */
export interface RaidDeps {
  /** villain を 1 体 spawn し id/名前を返す (§v1.3-D ㉙)。 */
  spawnVillain(): { id: string; name: string };
  /** villain を退場させる。 */
  despawnVillain(id: string): void;
  /** カルマを引く (討伐への投入)。足りなければ false。 */
  spend(userId: string, amount: number): boolean;
  /** カルマを配る (討伐報酬)。 */
  reward(userId: string, amount: number): void;
  /** 加算/減算後に本人へ状態 push する。 */
  pushState(userId: string): void;
  /** 時間切れ失敗の村への大被害を適用する。 */
  applyFailure(): void;
  /** 村の歴史へ 1 行刻む。 */
  chronicle(text: string): void;
  /** ハイライトに討伐を積む (§v1.3-D ㉑)。 */
  highlight(title: string, summary: string): void;
  /** レイド状態を配る。 */
  broadcast(active: boolean, villainName: string, hp: number, hpMax: number, endsInMs: number): void;
  /** world スナップショットを配る (spawn/despawn の反映)。 */
  snapshot(): void;
}

/** raidStrike の結果。defeated=この一撃で討伐確定。 */
export type RaidResult = { ok: true; defeated: boolean } | { ok: false; reason: string };

export class RaidManager {
  private active = false;
  private villainId = '';
  private villainName = '';
  private hpMax = 0;
  private damage = 0;
  private endsAt = 0;
  /** userId → 投入カルマ合計 (報酬の比例配分用)。 */
  private readonly contributions = new Map<string, number>();

  constructor(
    private readonly cfg: RaidConfig,
    private readonly deps: RaidDeps,
    private readonly rng: () => number = Math.random,
  ) {}

  /** レイドが進行中か。 */
  isActive(): boolean {
    return this.active;
  }

  /**
   * 日末などに低確率 (chance) で villain を出現させる (§v1.3-D ㉙)。
   * 多重防止 = 進行中なら出さない。出現したら true。
   */
  maybeSpawn(now: number): boolean {
    if (this.active) return false;
    if (this.rng() >= this.cfg.chance) return false;
    this.spawn(now);
    return true;
  }

  /** villain を強制出現させる (進行中なら false)。 */
  spawn(now: number): boolean {
    if (this.active) return false;
    const v = this.deps.spawnVillain();
    this.active = true;
    this.villainId = v.id;
    this.villainName = v.name;
    this.hpMax = this.cfg.hp;
    this.damage = 0;
    this.endsAt = now + this.cfg.windowMs;
    this.contributions.clear();
    this.deps.chronicle(`👹 共闘レイド: 凶悪な ${v.name} が現れた (制限時間 ${Math.round(this.cfg.windowMs / 1000)}秒)`);
    this.deps.snapshot();
    this.deps.broadcast(true, this.villainName, this.hpMax, this.hpMax, this.cfg.windowMs);
    return true;
  }

  /**
   * カルマを投じて villain の hp を amount 削る (§v1.3-D ㉙)。amount は正の整数。
   * カルマを spend し、総ダメージが hpMax を超えたら討伐 → 報酬を比例配分する。
   */
  strike(userId: string, amount: number, now: number): RaidResult {
    if (!this.active) return { ok: false, reason: 'いまレイドは出現していない' };
    if (now >= this.endsAt) return { ok: false, reason: 'レイドの制限時間が過ぎた' };
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: '投入カルマは正の整数' };
    if (!this.deps.spend(userId, amount)) return { ok: false, reason: 'カルマが足りない' };
    this.damage += amount;
    this.contributions.set(userId, (this.contributions.get(userId) ?? 0) + amount);
    this.deps.pushState(userId);
    if (this.damage >= this.hpMax) {
      this.victory();
      return { ok: true, defeated: true };
    }
    this.deps.broadcast(true, this.villainName, this.remainingHp(), this.hpMax, Math.max(0, this.endsAt - now));
    return { ok: true, defeated: false };
  }

  /** 討伐確定 (§v1.3-D ㉙)。villain 退場 + 参加者へ報酬を投入比例で山分け + ハイライト。 */
  private victory(): void {
    const name = this.villainName;
    const total = [...this.contributions.values()].reduce((s, n) => s + n, 0);
    if (total > 0) {
      for (const [userId, contrib] of this.contributions) {
        const share = Math.round((this.cfg.reward * contrib) / total);
        if (share > 0) {
          this.deps.reward(userId, share);
          this.deps.pushState(userId);
        }
      }
    }
    this.deps.despawnVillain(this.villainId);
    this.deps.chronicle(`⚔ 共闘レイド: ${name} を討伐した (報酬 ${this.cfg.reward} カルマ山分け)`);
    this.deps.highlight('レイド討伐', `凶悪な ${name} を協力して討ち取った`);
    this.reset();
    this.deps.snapshot();
    this.deps.broadcast(false, '', 0, 0, 0);
  }

  /** 制限時間判定 (§v1.3-D ㉙)。index が setInterval で回す。時間切れで失敗 = 村に大被害。 */
  tick(now: number): void {
    if (!this.active || now < this.endsAt) return;
    const name = this.villainName;
    this.deps.despawnVillain(this.villainId);
    this.deps.applyFailure();
    this.deps.chronicle(`💥 共闘レイド失敗: ${name} を討ち取れず村は大きな被害を受けた`);
    this.reset();
    this.deps.snapshot();
    this.deps.broadcast(false, '', 0, 0, 0);
  }

  /** 配信用の現状態 (接続時の初期配信用)。 */
  view(now: number): { active: boolean; villainName: string; hp: number; hpMax: number; endsInMs: number } {
    if (!this.active) return { active: false, villainName: '', hp: 0, hpMax: 0, endsInMs: 0 };
    return {
      active: true,
      villainName: this.villainName,
      hp: this.remainingHp(),
      hpMax: this.hpMax,
      endsInMs: Math.max(0, this.endsAt - now),
    };
  }

  private remainingHp(): number {
    return Math.max(0, this.hpMax - this.damage);
  }

  private reset(): void {
    this.active = false;
    this.villainId = '';
    this.villainName = '';
    this.hpMax = 0;
    this.damage = 0;
    this.endsAt = 0;
    this.contributions.clear();
  }
}

// --- seasons.json への追記保存 (§v1.3-D ㉚) -------------------------------------

/**
 * シーズンランキングを data/runtime/seasons.json (gitignore) へ追記保存する。
 * 既存配列を読んで push し直す (壊れていれば新規配列で始める)。
 * 失敗は握り潰さず console.error する (無言フォールバック禁止)。
 */
export class SeasonStore {
  private readonly path: string;

  constructor() {
    this.path = resolve(dataDir(), 'runtime', 'seasons.json');
  }

  append(record: SeasonRecord): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const records = this.load();
      records.push(record);
      writeFileSync(this.path, JSON.stringify(records, null, 2), 'utf8');
    } catch (e) {
      console.error('[pagus] seasons.json 保存失敗', e);
    }
  }

  private load(): SeasonRecord[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (Array.isArray(raw)) return raw as SeasonRecord[];
    } catch {
      /* 無ければ空配列で始める (保存なし扱い、無言フォールバックではない) */
    }
    return [];
  }
}
