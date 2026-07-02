// 起承転結ステートマシン。World と Brain を保持し、フェーズを 1 ステップずつ進める。
// 1 日 = 1 ターム = 12 セグメント。時間制御 (segmentRealMs のペース) は server が所有し、
// 本クラスは純粋な遷移ロジックを提供する。

import type { World, Villager, VillagerId, Incident, TrialState, Reform, Verdict, ActivityPattern, IncidentDesign, InfoItem, MartialMode } from './types/index.js';
import type { Brain, ActionDecision } from './brain.js';
import { aliveVillagers, awakeVillagers, environmentView, clampPos, bumpEventParam } from './world.js';
import { DailyEngine, REACTION_EXPOSURE, type DailyEngineOptions } from './daily-engine.js';
import { season, daysInMonth, holidayName } from './calendar.js';
import { groupByDominant, dominantAxis, PERSONALITY_AXES, PERSONALITY_LABELS, type PersonalityAxis } from './personality.js';
import { personalityFromVirtue, VIRTUES } from './virtue.js';
import { createVillager } from './villager-factory.js';
import type { WorldBrain, DayEvaluation, WorldEvalContext, HolidayEvent, MonthlySchedule } from './world-brain.js';
import type { BehaviorRule } from './behavior-rules.js';
import { settleEconomy, type EconomySettlement } from './economy.js';
import {
  resolveItemKind,
  applyItemEffect,
  collectItems as collectFieldItems,
  stepItemPickups,
  type ItemKindChoice,
  type ItemPickup,
} from './items.js';
import {
  heckleIncident,
  testifyInTrial,
  giveGift as giveGiftFn,
  DEFAULT_INTERVENTION,
  type InterventionConfig,
  type HeckleSide,
  type HeckleResult,
  type TestifyOutcome,
  type GiftKind,
  type GiftResult,
} from './interventions.js';
import type { FieldItem, FieldItemKind } from './types/index.js';
import {
  tickMayor,
  electMayor,
  recallMayor as recallMayorFn,
  DEFAULT_MAYOR,
  type MayorConfig,
  type MayorEvent,
  type RecallResult,
} from './mayor.js';
import type { EventDirector } from './event-director.js';

export type IdGen = () => string;

function counterIdGen(prefix: string): IdGen {
  let n = 0;
  return () => `${prefix}_${(n += 1)}`;
}

/** 0..1 に丸める。徳目評判・性格軸の適用後クランプに使う。 */
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** 復元した world.items の id (item_N) から最大番号を求める (§16, 通し番号の続きを決める)。 */
function maxItemIndex(items: FieldItem[]): number {
  let max = 0;
  for (const it of items) {
    const n = Number(it.id.replace(/^item_/, ''));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

/** 出生どうぶつの種の候補。 */
const SPAWN_SPECIES = ['猫', '兎', '梟', '熊', '栗鼠'] as const;
/** 出生どうぶつの活動特性の候補。 */
const SPAWN_ACTIVITIES: readonly ActivityPattern[] = ['diurnal', 'nocturnal', 'crepuscular', 'always'];

export interface TermMachineOptions {
  /** 起のイベント差配 (省略時は全 awake どうぶつの自由行動)。 */
  director?: EventDirector;
  /** 日常行動エンジン (LLM 非依存)。省略時は内部で生成する (§12.2)。 */
  dailyEngine?: DailyEngine;
  /** 日常エンジンの事件化閾値 (dailyEngine 未指定時に使う)。 */
  dailyTriggerAfter?: number;
  newIncidentId?: IdGen;
  /** 世界側 LLM。日末評価 (徳目評判・性格・出生) を司る。省略時は日末評価を行わない。 */
  worldBrain?: WorldBrain;
  /** 乱数源 (出生のばらつき用)。既定 Math.random。 */
  rng?: () => number;
  /** alive どうぶつの上限。出生はこの数未満の範囲でのみ起こる。既定 16。 */
  maxPopulation?: number;
  /**
   * 事件が裁判に至らず「和解」する基礎確率 (0..1, 1 ステップごとに判定)。既定 0 (無効)。
   * 住民は放置すると自然に和解へ向かう (沈静化操作は §4.1 で撤去)。扇動 (nudgeIncite) で下がる。
   */
  reconcileChance?: number;
  /** 事件中に第三者を巻き込む「二次被害」の確率 (0..1)。既定 0 (無効)。 */
  secondaryChance?: number;
  /** ストレス耐性の効き (被害者の平均 stress × これ = 受け流す確率)。既定 0 (無効)。 */
  stressFizzleK?: number;
  /** 日末に結婚イベントが起きる確率 (0..1)。既定 0。 */
  marriageChance?: number;
  /** 日末に夫婦から出産イベントが起きる確率 (0..1)。既定 0。 */
  birthChance?: number;
  /** スナップショット復元時の出生通し番号 (born_N が衝突しないよう引き継ぐ)。既定 0。 */
  bornCount?: number;
  /** スナップショット復元時の事件用キャラ通し番号 (incident_N が衝突しないよう引き継ぐ)。既定 0。 */
  incidentCount?: number;
  /** スナップショット復元時のふるまいの法則通し番号 (rule_haiku_N が衝突しないよう引き継ぐ)。既定 0。 */
  ruleCount?: number;
  /** ふるまいの法則の上限 (§2.1)。超えたら古い haiku ルールを 1 件間引く。既定 40。 */
  rulesMax?: number;
  /** 戒厳令 surge (§v1.3-C ⑨) 中に日常事件の閾値を下げる量。既定 4。 */
  martialSurgeBonus?: number;
  /** 村長選挙 (§17) のチューニング。省略時は DEFAULT_MAYOR。 */
  mayorConfig?: MayorConfig;
  /** 即効介入 (§v1.4-A 野次/証言/差し入れ) のチューニング。省略時は DEFAULT_INTERVENTION。 */
  interveneConfig?: InterventionConfig;
}

/** 日末の生活イベント (結婚/出産)。server がログ表示する。 */
export interface LifeEvents {
  marriages: Array<{ a: VillagerId; b: VillagerId; aName: string; bName: string }>;
  births: Array<{ childId: VillagerId; childName: string; parents: string }>;
}

/** 改変(いじられ方)の要約。server がログ表示する。 */
export interface ReformSummary {
  villager: VillagerId;
  name: string;
  text: string;
}

/** shoStep の結果。server がログ表示に使う。 */
export interface ShoResult {
  outcome: 'ongoing' | 'trial' | 'reconciled';
  /** 二次被害に巻き込まれた どうぶつ の名前 (無ければ null)。 */
  secondaryVictim: string | null;
}

export interface KishoTickResult {
  /** 起きていて行動した どうぶつ の行動概要。 */
  actions: Array<{ villager: VillagerId; action: string }>;
  /** この tick で事件が発火したか。 */
  incidentStarted: boolean;
}

export interface AdvanceDayResult {
  /** 月が変わったか (= 実 1 日境界の「大きな転換」)。 */
  monthRolled: boolean;
  /** 新しい日が祝日ならその名前。 */
  holiday: string | null;
  /** 村長選挙イベント (§17, 起きた時のみ)。server がログ。 */
  mayor: MayorEvent | null;
}

export class TermMachine {
  private pendingReform: Reform | null = null;
  private readonly director: EventDirector | null;
  /** 日常行動エンジン (LLM 非依存)。起の行動はここが決める (§12.2)。 */
  private readonly daily: DailyEngine;
  private readonly newIncidentId: IdGen;
  private readonly worldBrain: WorldBrain | null;
  private readonly rng: () => number;
  private readonly maxPopulation: number;
  private readonly reconcileChance: number;
  private readonly secondaryChance: number;
  private readonly stressFizzleK: number;
  private readonly marriageChance: number;
  private readonly birthChance: number;
  /** 沈静化/扇動が動かす和解バイアス (事件ごとに 0 へリセット)。 */
  private reconcileBias = 0;
  /** 接続ユーザごとの現ステージの票 (userId → {stage, pick})。投票し直しで自分の前票を差し替える。 */
  private userVotes = new Map<string, { stage: TrialState['stage']; pick: string }>();
  /** 出生どうぶつの通し番号 (seed の v_* と衝突しない born_N を振る)。 */
  private bornCount: number;
  /** 事件用キャラの通し番号 (incident_N を振る, §12.3.3)。 */
  private incidentCount: number;
  /** ふるまいの法則の通し番号 (rule_haiku_N を振る, §2.1)。 */
  private ruleCount: number;
  /** フィールドアイテムの通し番号 (§16)。復元した world.items と衝突しないよう既存最大値から続ける。 */
  private itemCount: number;
  /** ふるまいの法則の上限 (§2.1)。 */
  private readonly rulesMax: number;
  /** 戒厳令 surge (§v1.3-C ⑨) の閾値ボーナス。 */
  private readonly martialSurgeBonus: number;
  /** 村長選挙 (§17) のチューニング。 */
  private readonly mayorConfig: MayorConfig;
  /** 即効介入 (§v1.4-A) のチューニング。 */
  private readonly interveneConfig: InterventionConfig;
  /** その日の裁判結末。applyReform が incident/trial を null にする前に ketsuStep で捕捉する。 */
  private dayOutcome: { incident: Incident; verdict: Verdict; defendantId: VillagerId } | null = null;

  constructor(
    public readonly world: World,
    private readonly brain: Brain,
    opts: TermMachineOptions = {},
  ) {
    this.director = opts.director ?? null;
    const dailyOpts: DailyEngineOptions = {};
    if (opts.rng) dailyOpts.rng = opts.rng;
    if (opts.dailyTriggerAfter !== undefined) dailyOpts.triggerAfter = opts.dailyTriggerAfter;
    this.daily = opts.dailyEngine ?? new DailyEngine(dailyOpts);
    this.newIncidentId = opts.newIncidentId ?? counterIdGen('inc');
    this.worldBrain = opts.worldBrain ?? null;
    this.rng = opts.rng ?? Math.random;
    this.maxPopulation = opts.maxPopulation ?? 16;
    this.reconcileChance = opts.reconcileChance ?? 0;
    this.secondaryChance = opts.secondaryChance ?? 0;
    this.stressFizzleK = opts.stressFizzleK ?? 0;
    this.marriageChance = opts.marriageChance ?? 0;
    this.birthChance = opts.birthChance ?? 0;
    this.bornCount = opts.bornCount ?? 0;
    this.incidentCount = opts.incidentCount ?? 0;
    this.ruleCount = opts.ruleCount ?? 0;
    this.itemCount = maxItemIndex(world.items); // 復元した items の最大番号から続ける (衝突回避)
    this.rulesMax = opts.rulesMax ?? 40;
    this.martialSurgeBonus = opts.martialSurgeBonus ?? 4;
    this.mayorConfig = opts.mayorConfig ?? DEFAULT_MAYOR;
    this.interveneConfig = opts.interveneConfig ?? DEFAULT_INTERVENTION;
    // 村長 (§17): 復元時は world.mayorId を尊重し、未設定なら初回選挙で人気の村人を据える。
    if (world.mayorId === null && aliveVillagers(world).length > 0) {
      electMayor(world, this.mayorConfig);
    }
  }

  /** スナップショット保存用: 出生通し番号 (born_N が再起動後も衝突しないよう保持する)。 */
  getBornCount(): number {
    return this.bornCount;
  }

  /** スナップショット保存用: 事件用キャラ通し番号 (incident_N が再起動後も衝突しないよう保持する)。 */
  getIncidentCount(): number {
    return this.incidentCount;
  }

  /** スナップショット保存用: ふるまいの法則通し番号 (rule_haiku_N が再起動後も衝突しないよう保持する)。 */
  getRuleCount(): number {
    return this.ruleCount;
  }

  /**
   * ふるまいの法則を 1 つ増やす (RuleSmith, §2.1)。worldBrain が無ければ null。
   * worldBrain.proposeRule で起案 → world.behaviorRules に追加。
   * rulesMax を超えたら最古の haiku ルールを 1 件間引く。生成ルールを返す。
   */
  async maybeGrowRule(): Promise<BehaviorRule | null> {
    if (!this.worldBrain) return null;
    const proposed = await this.worldBrain.proposeRule({
      reputation: this.world.reputation,
      villagers: aliveVillagers(this.world),
      existingRules: this.world.behaviorRules,
      calendar: this.world.calendar,
    });
    this.ruleCount += 1;
    // id/source は呼び出し側で確定 (通し番号で衝突回避、source は haiku 固定)。
    const rule: BehaviorRule = { ...proposed, id: `rule_haiku_${this.ruleCount}`, source: 'haiku' };
    this.world.behaviorRules.push(rule);
    if (this.world.behaviorRules.length > this.rulesMax) {
      const oldest = this.world.behaviorRules.findIndex((r) => r.source === 'haiku');
      if (oldest >= 0) this.world.behaviorRules.splice(oldest, 1);
    }
    return rule;
  }

  /** プレイヤーの扇動: この事件が和解しにくくなる (= 裁判に持ち込みやすい)。 */
  nudgeIncite(): void {
    this.reconcileBias = Math.max(-0.5, this.reconcileBias - 0.12);
  }

  /** プレイヤーの扇動: 次の自由行動で事件化を促す (§12.4、日常エンジンへ委譲)。 */
  forceNext(): void {
    this.daily.forceNext();
  }

  // --- プレイヤー操作 (§4: 扇動/応援/制裁) ------------------------------------

  /** 偽情報 InfoItem の通し番号 (扇動の噂 id 用)。 */
  private rumorCount = 0;

  /**
   * 対象指定の扇動 (§4.2)。対象に偽情報を吹き込み、次の自由行動で事件化を促す。
   * rumorAboutId があれば「○○がお前の悪口を言っていた」、無ければ漠然とした不穏な噂。
   * 対象が生存しなければ false。
   */
  inciteTarget(targetId: VillagerId, rumorAboutId?: VillagerId): boolean {
    const target = this.world.villagers.get(targetId);
    if (!target || !target.alive) return false;
    this.rumorCount += 1;
    const rumorName = rumorAboutId ? this.world.villagers.get(rumorAboutId)?.name : undefined;
    const text = rumorName
      ? `「${rumorName}」がお前の悪口を言っていた`
      : '街で不穏な噂を聞いた';
    const item: InfoItem = {
      id: `rumor_${this.world.term}_${this.rumorCount}`,
      text,
      source: 'player',
      termAcquired: this.world.term,
    };
    target.information.push(item);
    this.daily.forceFor(targetId);
    this.nudgeIncite();
    return true;
  }

  /**
   * 応援 (§4.5)。対象の dominant 軸の trait を +0.1 (0..1 クランプ) する。
   * 応援した軸と名前を返す。対象が生存しなければ null。
   */
  cheer(targetId: VillagerId): { axis: PersonalityAxis; villagerName: string } | null {
    const target = this.world.villagers.get(targetId);
    if (!target || !target.alive) return null;
    const axis = dominantAxis(target.persona.traits);
    target.persona.traits[axis] = clamp01(target.persona.traits[axis] + 0.1);
    return { axis, villagerName: target.name };
  }

  /**
   * 制裁 (§4.3)。対象を即時つるし上げ裁判にかける。対象が生存しかつ進行中の
   * 事件/裁判が無いときのみ true。合成事件 (origin:'sanction') + 固定被告の裁判を開く。
   */
  sanction(targetId: VillagerId): boolean {
    const target = this.world.villagers.get(targetId);
    if (!target || !target.alive) return false;
    if (this.world.incident || this.world.trial) return false;
    const incident: Incident = {
      id: this.newIncidentId(),
      perpetrator: targetId,
      involved: [],
      description: `制裁: ${target.name} がつるし上げられた`,
      damage: 0,
      steps: [],
      resolved: true,
      origin: 'sanction',
    };
    this.world.incident = incident;
    this.world.trial = this.openTrialFixed(incident, targetId);
    this.world.phase = 'ten';
    return true;
  }

  /** 固定被告の裁判を開く (§4.3 制裁: foolish 段階を飛ばして fate から始める)。 */
  private openTrialFixed(incident: Incident, defendantId: VillagerId): TrialState {
    this.userVotes.clear();
    return {
      incidentId: incident.id,
      judge: { kind: 'nekomori' },
      candidates: [defendantId],
      stage: 'fate',
      pendingGroups: this.groupAxes(),
      foolishVotes: {},
      defendant: defendantId,
      fateVotes: { kill: 0, spare: 0 },
      votes: [],
      verdict: null,
    };
  }

  // --- 即効介入 (§v1.4-A 野次/証言/差し入れ) --------------------------------------

  /**
   * 野次 (§v1.4-A)。進行中の事件 (承) 限定。agitate=被害を即加算し和解しにくく、
   * soothe=和解しやすくする。当事者へ HECKLED_TAG が残る。事件中でなければ null。
   */
  heckle(side: HeckleSide): HeckleResult | null {
    if (this.world.phase !== 'sho' || !this.world.incident) return null;
    const r = heckleIncident(this.world, this.world.incident, side, this.interveneConfig);
    this.reconcileBias = Math.min(0.5, Math.max(-0.5, this.reconcileBias + r.biasDelta));
    return r;
  }

  /**
   * 証言の投げ込み (§v1.4-A)。裁判の運命 (fate) 段階に 1 グループ分の重みで票を上乗せする。
   * 1 ユーザ 1 裁判 1 回。裁判が無ければ不成立を返す。
   */
  testify(userId: string, stance: 'accuse' | 'defend', text?: string): TestifyOutcome {
    const trial = this.world.trial;
    if (!trial || this.world.phase !== 'ten') return { ok: false, reason: '証言できる裁判が開いていない' };
    return testifyInTrial(this.world, trial, userId, stance, text);
  }

  /**
   * 贈り物の手渡し (§v1.4-A)。treat=差し入れ (喜び+富) / poison=毒饅頭 (薬物と同じ荒れ方)。
   * 対象が不在/退場なら null。
   */
  giveGift(targetId: VillagerId, kind: GiftKind): GiftResult | null {
    return giveGiftFn(this.world, targetId, kind, this.interveneConfig);
  }

  // --- カードパック (§v1.3-A) ----------------------------------------------------

  /** 天災カード等の一時 BehaviorRule を村に足す (§v1.3-A ⑯)。TTL は rule.expiresAtTerm。 */
  addCardRule(rule: BehaviorRule): void {
    this.world.behaviorRules.push(rule);
  }

  /**
   * 失効した一時ルール (expiresAtTerm <= world.term) を除去する (§v1.3 TTL)。
   * server が日末 (advanceDay 後) に呼ぶ。除去したルールを返す。
   */
  pruneExpiredRules(): BehaviorRule[] {
    const removed: BehaviorRule[] = [];
    for (let i = this.world.behaviorRules.length - 1; i >= 0; i -= 1) {
      const r = this.world.behaviorRules[i];
      if (r && r.expiresAtTerm !== undefined && r.expiresAtTerm <= this.world.term) {
        removed.push(r);
        this.world.behaviorRules.splice(i, 1);
      }
    }
    return removed;
  }

  /**
   * 神隠し (§v1.3-A ⑰)。対象を days ターム退避させる (hiddenUntilTerm = term + days)。
   * 進行中裁判の被告 (または候補) なら裁判を中断し起 (kisho) へ戻す (裁判逃れ)。
   * 対象が生存しなければ false。
   */
  spiritAway(targetId: VillagerId, days: number): boolean {
    const target = this.world.villagers.get(targetId);
    if (!target || !target.alive) return false;
    target.hiddenUntilTerm = this.world.term + days;
    const trial = this.world.trial;
    if (trial && (trial.defendant === targetId || trial.candidates.includes(targetId))) {
      // 裁判の被告が消えた → 進行中の事件/裁判を中断して起へ戻す。
      this.world.incident = null;
      this.world.trial = null;
      this.world.phase = 'kisho';
    }
    return true;
  }

  /**
   * 入れ替え (§v1.3-A ⑱)。2 住民の persona.traits と appearance を交換する。
   * どちらかが不在/同一なら false。
   */
  swapVillagers(aId: VillagerId, bId: VillagerId): boolean {
    if (aId === bId) return false;
    const a = this.world.villagers.get(aId);
    const b = this.world.villagers.get(bId);
    if (!a || !b) return false;
    const traits = a.persona.traits;
    a.persona.traits = b.persona.traits;
    b.persona.traits = traits;
    const appearance = a.appearance;
    a.appearance = b.appearance;
    b.appearance = appearance;
    return true;
  }

  /**
   * 覚醒 (§v1.3-A ⑲)。対象の最小気質軸を高位 (0.9) へ引き上げる (隠し気質の解放)。
   * 引き上げた軸を返す。対象が生存しなければ null。
   */
  awaken(targetId: VillagerId): { axis: PersonalityAxis } | null {
    const target = this.world.villagers.get(targetId);
    if (!target || !target.alive) return null;
    let minAxis: PersonalityAxis = PERSONALITY_AXES[0];
    for (const ax of PERSONALITY_AXES) {
      if (target.persona.traits[ax] < target.persona.traits[minAxis]) minAxis = ax;
    }
    target.persona.traits[minAxis] = 0.9;
    return { axis: minAxis };
  }

  /**
   * 偽予言 (§v1.3-A ⑳)。生存住民全員に偽 InfoItem を撒き、各自の REACTION_EXPOSURE を +1 して
   * 翌日のアルゴリズムイベントを底上げする。注入した人数を返す。
   */
  falseProphecy(text?: string): number {
    const body = text && text.trim().length > 0 ? text.trim() : '村に災いが訪れるという不吉な予言を聞いた';
    let n = 0;
    for (const v of aliveVillagers(this.world)) {
      this.rumorCount += 1;
      const item: InfoItem = {
        id: `prophecy_${this.world.term}_${this.rumorCount}`,
        text: body,
        source: 'player',
        termAcquired: this.world.term,
      };
      v.information.push(item);
      bumpEventParam(v, REACTION_EXPOSURE, 1);
      n += 1;
    }
    return n;
  }

  // --- 経済パック (§v1.3-B 闇市) -------------------------------------------------

  /**
   * 復活 (§v1.3-B ⑤ 闇市 revive)。退場済み (alive=false) のどうぶつを 1 体 alive へ戻す。
   * 対象が存在しかつ現に退場している (alive=false) ときのみ true。既に生存/不在なら false。
   */
  revive(villagerId: VillagerId): boolean {
    const v = this.world.villagers.get(villagerId);
    if (!v || v.alive) return false;
    v.alive = true;
    return true;
  }

  // --- 政治パック (§v1.3-C) ------------------------------------------------------

  /**
   * 戒厳令を発動する (§v1.3-C ⑨)。world.martial = {mode, untilTerm: term + days} を立てる。
   * days は 1 以上 (それ未満なら 1 にクランプ)。再発動は上書き。
   */
  setMartial(mode: MartialMode, days: number): void {
    const span = Math.max(1, Math.floor(days));
    this.world.martial = { mode, untilTerm: this.world.term + span };
  }

  /** 戒厳令が発動中か (mode 指定時はその mode のみ)。term <= untilTerm の間だけ有効。 */
  martialActive(mode?: MartialMode): boolean {
    const m = this.world.martial;
    if (!m || m.untilTerm < this.world.term) return false;
    return mode === undefined || m.mode === mode;
  }

  /**
   * 失効した戒厳令 (untilTerm < world.term) を解除する (§v1.3-C ⑨, 日末)。
   * server が advanceDay 後に呼ぶ。解除した mode を返す (発動なし/未失効なら null)。
   */
  pruneExpiredMartial(): MartialMode | null {
    const m = this.world.martial;
    if (!m || m.untilTerm >= this.world.term) return null;
    delete this.world.martial;
    return m.mode;
  }

  /**
   * 革命の決着を村の評判へ反映する (§v1.3-C ⑧)。incite 勝利は悪辣↑秩序↓ (混乱)、
   * suppress 勝利は悪辣↓秩序↑ (鎮静)。適用後 0..1 にクランプし、変化後の reputation を返す。
   */
  applyRevolt(side: 'incite' | 'suppress'): { malice: number; order: number } {
    const rep = this.world.reputation;
    if (side === 'incite') {
      rep.malice = clamp01(rep.malice + 0.2);
      rep.order = clamp01(rep.order - 0.15);
    } else {
      rep.malice = clamp01(rep.malice - 0.2);
      rep.order = clamp01(rep.order + 0.15);
    }
    return { malice: rep.malice, order: rep.order };
  }

  /**
   * 村基金イベントを発火する (§v1.3-C ⑩)。festival=祝祭で活気↑ / relief=救済で全住民の stress を下げる。
   * 影響を受けた人数 (relief) または 0 (festival) を返す。
   */
  villageFundEvent(kind: 'festival' | 'relief'): number {
    if (kind === 'festival') {
      this.world.reputation.vitality = clamp01(this.world.reputation.vitality + 0.15);
      return 0;
    }
    let n = 0;
    for (const v of aliveVillagers(this.world)) {
      v.stress = Math.max(0, v.stress - 2);
      n += 1;
    }
    return n;
  }

  // --- 演出・協力パック (§v1.3-D) ------------------------------------------------

  /**
   * 観客の祈り (§v1.3-D ㉕) の村バフを適用する。村の評判 (善良 +0.05 / 活気 +0.05) を上げ、
   * 全生存どうぶつの stress を 1 下げる (下限0)。stress を下げた人数を返す。
   */
  applyPrayerBuff(): number {
    const rep = this.world.reputation;
    rep.benevolence = clamp01(rep.benevolence + 0.05);
    rep.vitality = clamp01(rep.vitality + 0.05);
    let n = 0;
    for (const v of aliveVillagers(this.world)) {
      v.stress = Math.max(0, v.stress - 1);
      n += 1;
    }
    return n;
  }

  /**
   * 共闘レイド (§v1.3-D ㉙) の凶悪 villain を 1 体生成して村に投入する。
   * 事件用キャラ (origin 'incident') として強気質 (攻撃性高・優しさ低・規律低) で spawn する。
   * 生成したどうぶつを返す。
   */
  spawnVillain(name: string): Villager {
    this.incidentCount += 1;
    const v = createVillager({
      id: `incident_${this.incidentCount}`,
      name,
      position: {
        x: Math.floor(this.rng() * this.world.config.gridWidth),
        y: Math.floor(this.rng() * this.world.config.gridHeight),
      },
      species: '狼',
      activity: 'always',
      traits: { aggression: 0.95, kindness: 0.05, discipline: 0.1 },
      origin: 'incident',
    });
    this.world.villagers.set(v.id, v);
    return v;
  }

  /** レイドの villain を退場させる (§v1.3-D ㉙, 討伐/時間切れ時)。生存していたら alive=false にして true。 */
  despawnVillain(villagerId: VillagerId): boolean {
    const v = this.world.villagers.get(villagerId);
    if (!v || !v.alive) return false;
    v.alive = false;
    return true;
  }

  /**
   * レイド失敗 (§v1.3-D ㉙, 時間切れ) の村への大被害を適用する。悪辣 +0.15 / 活気 -0.1 (クランプ)、
   * 全生存どうぶつの stress を +2 する。被害を受けた人数を返す。
   */
  applyRaidFailure(): number {
    const rep = this.world.reputation;
    rep.malice = clamp01(rep.malice + 0.15);
    rep.vitality = clamp01(rep.vitality - 0.1);
    let n = 0;
    for (const v of aliveVillagers(this.world)) {
      v.stress += 2;
      n += 1;
    }
    return n;
  }

  // --- 月次事件のライフサイクル (§12.3) ----------------------------------------

  /**
   * 月初: その月の事件発生日を世界側 LLM が 1 つ決める (§12.3.1)。worldBrain が無ければ null。
   * dayOfMonth は [1, daysInMonth] にクランプし scheduledIncident を設定する。
   */
  async scheduleMonthlyIncident(): Promise<MonthlySchedule | null> {
    if (!this.worldBrain) return null;
    const cal = this.world.calendar;
    const m = await this.worldBrain.scheduleMonthlyIncident({
      calendar: cal,
      reputation: this.world.reputation,
      villagers: aliveVillagers(this.world),
      villageRules: this.world.villageRules,
    });
    const dayOfMonth = Math.min(cal.daysInMonth, Math.max(1, Math.round(m.dayOfMonth)));
    this.world.scheduledIncident = {
      dayOfMonth,
      themeSeed: m.themeSeed,
      designed: false,
      fired: false,
      design: null,
    };
    return { dayOfMonth, themeSeed: m.themeSeed };
  }

  /**
   * 事件前日: 世界側 LLM が事件を詳細デザインし、事件用キャラを生成して村に投入する (§12.3.2/3)。
   * scheduledIncident が無い/デザイン済み/worldBrain 無しなら null。
   * 加害者が解決できなければ throw (無言フォールバック禁止)。
   */
  async designScheduledIncident(): Promise<{ design: IncidentDesign; spawned: Villager[] } | null> {
    const sched = this.world.scheduledIncident;
    if (!sched || sched.designed || !this.worldBrain) return null;

    // 連続犯の継続入力: 居座る過去の事件用キャラ。
    const survivingCulprits = aliveVillagers(this.world).filter((v) => v.origin === 'incident');
    const design = await this.worldBrain.designIncident({
      calendar: this.world.calendar,
      reputation: this.world.reputation,
      villagers: aliveVillagers(this.world),
      villageRules: this.world.villageRules,
      themeSeed: sched.themeSeed,
      survivingCulprits,
    });

    // 事件用キャラを spawn して村に追加する。
    const spawned: Villager[] = [];
    for (const spec of design.newCharacters) {
      this.incidentCount += 1;
      const seed: Parameters<typeof createVillager>[0] = {
        id: `incident_${this.incidentCount}`,
        name: spec.name,
        position: {
          x: Math.floor(this.rng() * this.world.config.gridWidth),
          y: Math.floor(this.rng() * this.world.config.gridHeight),
        },
        species: spec.species,
        origin: 'incident',
      };
      if (spec.activity !== undefined) seed.activity = spec.activity;
      if (spec.traits !== undefined) seed.traits = spec.traits;
      if (spec.values !== undefined) seed.values = spec.values;
      if (spec.speechStyle !== undefined) seed.speechStyle = spec.speechStyle;
      if (spec.body !== undefined) seed.body = spec.body;
      const v = createVillager(seed);
      this.world.villagers.set(v.id, v);
      spawned.push(v);
    }

    // 加害者を解決: 既存 id があればそれ、無ければ spawned のうち perpetrator:true の最初の 1 体。
    let perpetratorId: VillagerId | null = design.perpetratorId;
    if (perpetratorId === null) {
      const perpIndex = design.newCharacters.findIndex((c) => c.perpetrator);
      const perp = perpIndex >= 0 ? spawned[perpIndex] : undefined;
      if (!perp) throw new Error('designIncident: 加害者を解決できません (perpetratorId も加害キャラも無し)');
      perpetratorId = perp.id;
    }

    // 巻き込む既存住民 + 加害者でない spawned victim を involved に含める。
    const involvedIds = [...design.involvedIds];
    for (const v of spawned) {
      if (v.id !== perpetratorId) involvedIds.push(v.id);
    }

    const finalDesign: IncidentDesign = {
      description: design.description,
      newCharacters: design.newCharacters,
      involvedIds,
      perpetratorId,
      scapegoat: design.scapegoat,
      framedTargetId: design.framedTargetId,
    };
    sched.design = finalDesign;
    sched.designed = true;
    return { design: finalDesign, spawned };
  }

  /**
   * 発生日: スケジュール済み事件を発火する (§12.3)。デザイン済みかつ未発火、
   * 当日かつ phase が kisho/idle で進行中の事件が無いときのみ true を返して承へ。
   */
  fireScheduledIncident(): boolean {
    const sched = this.world.scheduledIncident;
    if (!sched || !sched.designed || sched.fired || !sched.design) return false;
    if (this.world.calendar.dayOfMonth !== sched.dayOfMonth) return false;
    if (this.world.phase !== 'kisho' && this.world.phase !== 'idle') return false;
    if (this.world.incident) return false;
    // 戒厳令 freeze (§v1.3-C ⑨): 月次スケジュール事件を一時凍結する (発火させない)。
    if (this.martialActive('freeze')) return false;

    const design = sched.design;
    if (design.perpetratorId === null) {
      throw new Error('fireScheduledIncident: 加害者が未解決のデザインです');
    }
    this.world.incident = this.startIncident(
      design.perpetratorId,
      { description: design.description, involved: design.involvedIds },
      { origin: 'designed', framedTargetId: design.scapegoat ? design.framedTargetId : null },
    );
    this.world.phase = 'sho';
    sched.fired = true;
    return true;
  }

  /** その日 (ターム) を開始する。idle → 起。 */
  startDay(): void {
    this.world.phase = 'kisho';
    this.director?.resetDay();
  }

  private get(id: VillagerId): Villager {
    const v = this.world.villagers.get(id);
    if (!v) throw new Error(`villager not found: ${id}`);
    return v;
  }

  // --- 起: 現セグメントの行動 (director があれば代表のみ、無ければ全 awake) ---
  async kishoTick(): Promise<KishoTickResult> {
    if (this.world.phase !== 'kisho') throw new Error(`kishoTick in phase ${this.world.phase}`);
    // 日常エンジンに現在の ふるまいの法則 を流し込む (Haiku 増殖が即反映される, §2.1)。
    this.daily.setRules(this.world.behaviorRules);
    // 戒厳令 surge (§v1.3-C ⑨): 発動中だけ事件化閾値を下げる (解除で 0 に戻る)。
    this.daily.setSurge(this.martialActive('surge') ? this.martialSurgeBonus : 0);
    const actions: KishoTickResult['actions'] = [];

    if (this.director) {
      const remaining = this.world.config.segmentsPerDay - this.world.calendar.segment;
      for (const directive of this.director.planSegment(this.world, remaining)) {
        const actor = this.world.villagers.get(directive.actor);
        if (!actor || !actor.alive) continue;
        // 日常エンジン (LLM 非依存) が行動を決める (§12.2)。
        const decision = this.daily.decide(actor, environmentView(this.world, actor), directive);
        if (this.applyDecision(actor, decision, actions)) return { actions, incidentStarted: true };
      }
      return { actions, incidentStarted: false };
    }

    for (const villager of awakeVillagers(this.world)) {
      const decision = this.daily.decide(villager, environmentView(this.world, villager), null);
      if (this.applyDecision(villager, decision, actions)) return { actions, incidentStarted: true };
    }
    return { actions, incidentStarted: false };
  }

  /** 行動を適用。事件が発火したら true を返し phase を sho にする。 */
  private applyDecision(
    actor: Villager,
    decision: ActionDecision,
    actions: KishoTickResult['actions'],
  ): boolean {
    if (decision.move) actor.position = clampPos(this.world, decision.move);
    actor.emotion = decision.newEmotion;
    actions.push({ villager: actor.id, action: decision.action });
    if (decision.triggersIncident && decision.incidentSeed && !this.world.incident) {
      const seed = decision.incidentSeed;
      const victimIds = seed.involved.filter((id) => id !== actor.id);
      // ストレス耐性: 被害者が慣れっこなら、些細な嫌がらせは受け流して事件化しない。
      if (this.shrugsOff(victimIds)) {
        const v0 = victimIds[0] ? this.world.villagers.get(victimIds[0]) : undefined;
        actions.push({ villager: v0?.id ?? actor.id, action: `${v0?.name ?? '相手'}は慣れっこで受け流した` });
        return false;
      }
      this.world.incident = this.startIncident(actor.id, seed);
      this.world.phase = 'sho';
      return true;
    }
    return false;
  }

  /** 被害者の平均ストレス耐性で嫌がらせを受け流すか判定。 */
  private shrugsOff(victimIds: VillagerId[]): boolean {
    if (this.stressFizzleK <= 0 || victimIds.length === 0) return false;
    let sum = 0;
    let n = 0;
    for (const id of victimIds) {
      const v = this.world.villagers.get(id);
      if (v) {
        sum += v.stress;
        n += 1;
      }
    }
    if (n === 0) return false;
    const chance = Math.min(0.8, (sum / n) * this.stressFizzleK);
    return this.rng() < chance;
  }

  /** 現セグメントを終え、次セグメントへ。日末 (segment 一巡) に達したら phase=advance。 */
  advanceSegment(): { dayEnded: boolean } {
    if (this.world.phase !== 'kisho') throw new Error(`advanceSegment in phase ${this.world.phase}`);
    const next = this.world.calendar.segment + 1;
    if (next >= this.world.config.segmentsPerDay) {
      this.world.phase = 'advance';
      return { dayEnded: true };
    }
    this.world.calendar.segment = next;
    return { dayEnded: false };
  }

  private startIncident(
    perpetrator: VillagerId,
    seed: { description: string; involved: string[] },
    opts: { origin?: 'organic' | 'designed'; framedTargetId?: VillagerId | null } = {},
  ): Incident {
    this.reconcileBias = 0; // 事件ごとに和解バイアスをリセット。
    const involved = seed.involved.filter((id) => id !== perpetrator);
    // 事件をくぐった者はストレス耐性が上がり (些細な嫌がらせに動じにくい)、
    // イベント由来パラメータ (§12.6) が溜まって以後アルゴリズムイベントを起こしやすくなる。
    for (const id of [perpetrator, ...involved]) {
      const v = this.world.villagers.get(id);
      if (v) {
        v.stress += 1;
        bumpEventParam(v, REACTION_EXPOSURE, 1);
      }
    }
    const incident: Incident = {
      id: this.newIncidentId(),
      perpetrator,
      involved,
      description: seed.description,
      damage: 0,
      steps: [],
      resolved: false,
      origin: opts.origin ?? 'organic',
    };
    // exactOptionalPropertyTypes: framedTargetId は値があるときだけキーを足す。
    if (opts.framedTargetId != null) incident.framedTargetId = opts.framedTargetId;
    return incident;
  }

  // --- 承: 事件 (GANs) 1 ステップ ---
  async shoStep(): Promise<ShoResult> {
    if (this.world.phase !== 'sho' || !this.world.incident) {
      throw new Error(`shoStep without active incident (phase ${this.world.phase})`);
    }
    const incident = this.world.incident;
    // 加害者視点 → 被害者視点 を交互に。
    const perspective = incident.steps.length % 2 === 0 ? 'perpetrator' : 'victim';
    const victims = incident.involved.map((id) => this.get(id));
    const step = await this.brain.advanceIncident({
      incident,
      perspective,
      perpetrator: this.get(incident.perpetrator),
      victims,
    });
    incident.steps.push({ perspective, action: step.action, damageDelta: step.damageDelta });
    incident.damage += step.damageDelta;

    // 事件が一線を越えたら裁判へ (和解より優先)。
    if (step.ended || incident.damage >= this.world.config.damageThreshold) {
      incident.resolved = true;
      this.world.trial = this.openTrial(incident);
      this.world.phase = 'ten';
      return { outcome: 'trial', secondaryVictim: null };
    }

    // 二次被害: 一定確率で第三者を巻き込む。
    let secondaryVictim: string | null = null;
    if (this.rng() < this.secondaryChance) {
      const bystanders = aliveVillagers(this.world).filter(
        (v) => v.id !== incident.perpetrator && !incident.involved.includes(v.id),
      );
      const victim = bystanders[Math.floor(this.rng() * bystanders.length)];
      if (victim) {
        incident.involved.push(victim.id);
        incident.damage += 2;
        secondaryVictim = victim.name;
      }
    }

    // 和解: 沈静化で上がり扇動で下がる。被害が大きいほど和解しにくい。
    const damageRatio = incident.damage / this.world.config.damageThreshold;
    const chance = this.reconcileChance + this.reconcileBias - damageRatio * 0.1;
    if (incident.steps.length >= 1 && this.rng() < chance) {
      incident.resolved = true;
      this.world.incident = null;
      this.world.phase = 'kisho';
      return { outcome: 'reconciled', secondaryVictim };
    }

    return { outcome: 'ongoing', secondaryVictim };
  }

  private groupAxes(): PersonalityAxis[] {
    return [...groupByDominant(aliveVillagers(this.world), (v) => v.persona.traits).keys()];
  }

  private votersOf(axis: PersonalityAxis): Villager[] {
    return aliveVillagers(this.world).filter((v) => dominantAxis(v.persona.traits) === axis);
  }

  private openTrial(incident: Incident): TrialState {
    this.userVotes.clear();
    return {
      incidentId: incident.id,
      judge: { kind: 'nekomori' },
      candidates: [incident.perpetrator, ...incident.involved],
      stage: 'foolish',
      pendingGroups: this.groupAxes(),
      foolishVotes: {},
      defendant: null,
      fateVotes: { kill: 0, spare: 0 },
      votes: [],
      verdict: null,
    };
  }

  /**
   * 接続ユーザの通知投票 1 票を現段階に加える (§4.8)。
   * 各 userId が 1 席 (重み 1) を持ち、複数ユーザの票は合算される。
   * 同じユーザが同段階で投票し直したら、自分の前票だけを取り消して差し替える。
   * userId 省略時は単独ローカル観戦者 ('local') として扱う。
   */
  addUserVote(pick: string, userId = 'local'): void {
    const trial = this.world.trial;
    if (!trial || trial.stage === 'decided') return;

    // 同段階の自分の前票を取り消す (投票し直し)。
    const prevVote = this.userVotes.get(userId);
    if (prevVote && prevVote.stage === trial.stage) {
      const prev = prevVote.pick;
      if (trial.stage === 'foolish') {
        trial.foolishVotes[prev] = Math.max(0, (trial.foolishVotes[prev] ?? 0) - 1);
      } else if (prev === 'kill') {
        trial.fateVotes.kill = Math.max(0, trial.fateVotes.kill - 1);
      } else if (prev === 'spare') {
        trial.fateVotes.spare = Math.max(0, trial.fateVotes.spare - 1);
      }
      const i = trial.votes.findIndex((v) => v.voter === 'user' && v.userId === userId && v.pick === prev);
      if (i >= 0) trial.votes.splice(i, 1);
    }

    trial.votes.push({ voter: 'user', weight: 1, pick, userId });
    if (trial.stage === 'foolish') trial.foolishVotes[pick] = (trial.foolishVotes[pick] ?? 0) + 1;
    else if (pick === 'kill') trial.fateVotes.kill += 1;
    else if (pick === 'spare') trial.fateVotes.spare += 1;
    this.userVotes.set(userId, { stage: trial.stage, pick });
  }

  /** 生存している狂人 (いなければ null)。 */
  private aliveMadman(): Villager | null {
    for (const v of this.world.villagers.values()) if (v.alive && v.madman) return v;
    return null;
  }

  /** 狂人の扇動の重み。村の評判が悪辣・無秩序なほど強くなる。 */
  private madmanWeight(): number {
    const rep = this.world.reputation;
    return Math.round(1 + rep.malice * 5 + (1 - rep.order) * 2);
  }

  /** 候補のうち最も「善良で無害」な者 (優しさ高・攻撃性低) = 陥れる標的。 */
  private scapegoat(candidateIds: VillagerId[]): VillagerId | null {
    let best: VillagerId | null = null;
    let bestScore = -Infinity;
    for (const id of candidateIds) {
      const v = this.world.villagers.get(id);
      if (!v || v.madman) continue;
      const score = v.persona.traits.kindness - v.persona.traits.aggression;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  // --- 転: グループ bloc 投票 (1 グループ/ステップ) ---
  async tenStep(): Promise<void> {
    if (this.world.phase !== 'ten' || !this.world.trial || !this.world.incident) {
      throw new Error(`tenStep without active trial (phase ${this.world.phase})`);
    }
    const trial = this.world.trial;
    const incident = this.world.incident;
    const axis = trial.pendingGroups.shift();
    if (!axis) return; // 念のため (グループ無し)
    const voters = this.votersOf(axis);

    if (trial.stage === 'foolish') {
      const candidates = trial.candidates.map((id) => this.get(id));
      const pick = await this.brain.groupVoteFoolish({ axis, voters, candidates, incident });
      trial.foolishVotes[pick] = (trial.foolishVotes[pick] ?? 0) + voters.length;
      trial.votes.push({ voter: axis, weight: voters.length, pick });
      if (trial.pendingGroups.length === 0) {
        // 狂人の扇動: 全グループ投票後、最も善良な候補へ重い票を投げて陥れる。
        const madman = this.aliveMadman();
        if (madman) {
          const target = this.scapegoat(trial.candidates);
          if (target) {
            const w = this.madmanWeight();
            trial.foolishVotes[target] = (trial.foolishVotes[target] ?? 0) + w;
            trial.votes.push({ voter: 'madman', weight: w, pick: target });
          }
        }
        // 連続犯: 真犯人 (事件用キャラ) が陥れる対象が候補にいれば重い擦り付け票を加える (§12.3.3)。
        // 無実の既存住民が被告に選ばれやすくなり、真犯人は alive のまま居座る。
        const framed = incident.framedTargetId;
        if (framed && trial.candidates.includes(framed)) {
          const w = Math.round(3 + this.world.reputation.malice * 4);
          trial.foolishVotes[framed] = (trial.foolishVotes[framed] ?? 0) + w;
          trial.votes.push({ voter: 'culprit', weight: w, pick: framed });
        }
        trial.defendant = this.argmaxCandidate(trial);
        trial.stage = 'fate';
        trial.pendingGroups = this.groupAxes();
      }
    } else if (trial.stage === 'fate') {
      const defendant = this.get(trial.defendant as VillagerId);
      const vote = await this.brain.groupVoteFate({ axis, voters, defendant, incident });
      if (vote === 'kill') trial.fateVotes.kill += voters.length;
      else trial.fateVotes.spare += voters.length;
      trial.votes.push({ voter: axis, weight: voters.length, pick: vote });
      if (trial.pendingGroups.length === 0) {
        // 狂人の扇動: 処刑へ重い票を上乗せする。
        const madman = this.aliveMadman();
        if (madman) {
          const w = this.madmanWeight();
          trial.fateVotes.kill += w;
          trial.votes.push({ voter: 'madman', weight: w, pick: 'kill' });
        }
        trial.verdict = trial.fateVotes.kill > trial.fateVotes.spare ? 'death' : 'spared';
        trial.stage = 'decided';
        this.world.phase = 'ketsu';
      }
    }
  }

  /** 最多得票の候補 (同票は candidates の並び順で先勝ち)。 */
  private argmaxCandidate(trial: TrialState): VillagerId {
    let best = trial.candidates[0] as VillagerId;
    let bestVotes = trial.foolishVotes[best] ?? 0;
    for (const id of trial.candidates) {
      const v = trial.foolishVotes[id] ?? 0;
      if (v > bestVotes) {
        best = id;
        bestVotes = v;
      }
    }
    return best;
  }

  // --- 結: 教育内容決定 ---
  async ketsuStep(): Promise<void> {
    if (this.world.phase !== 'ketsu' || !this.world.trial || !this.world.incident) {
      throw new Error(`ketsuStep without verdict (phase ${this.world.phase})`);
    }
    const trial = this.world.trial;
    const defendant = this.get(trial.defendant as VillagerId);
    // applyReform が後で incident/trial を null にするため、日末評価用にここで捕捉する。
    this.dayOutcome = {
      incident: this.world.incident,
      verdict: trial.verdict as Verdict,
      defendantId: trial.defendant as VillagerId,
    };
    if (trial.verdict === 'death') {
      // 殺す → 追放 (退場)。
      this.pendingReform = { kind: 'exile', villager: defendant.id, rationale: '村の投票により処刑された' };
    } else {
      // 活かす → 強制的に良い子へ教育。
      this.pendingReform = await this.brain.decideEducation({
        trial,
        incident: this.world.incident,
        perpetrator: defendant,
      });
    }
    this.world.phase = 'reform';
  }

  /** 結の保留中の改変を適用し、その日の残りセグメントへ復帰 (起)。改変内容を要約で返す。 */
  applyReform(): ReformSummary | null {
    if (this.world.phase !== 'reform') throw new Error(`applyReform in phase ${this.world.phase}`);
    let summary: ReformSummary | null = null;
    if (this.pendingReform) {
      const v = this.world.villagers.get(this.pendingReform.villager);
      const text = this.reform(this.pendingReform);
      summary = { villager: this.pendingReform.villager, name: v?.name ?? this.pendingReform.villager, text };
    }
    this.pendingReform = null;
    this.world.incident = null;
    this.world.trial = null;
    this.world.phase = 'kisho';
    return summary;
  }

  /** 改変を適用し「どういじられたか」の要約文を返す。 */
  private reform(reform: Reform): string {
    const v = this.get(reform.villager);
    if (reform.kind === 'exile') {
      v.alive = false;
      return `${v.name} は村を追放された (${reform.rationale})`;
    }
    const changes: string[] = [];
    if (reform.persona?.traits) {
      for (const [k, nv] of Object.entries(reform.persona.traits)) {
        if (typeof nv !== 'number') continue;
        const ax = k as PersonalityAxis;
        const ov = v.persona.traits[ax];
        const arrow = nv > ov ? '↑' : nv < ov ? '↓' : '→';
        changes.push(`${PERSONALITY_LABELS[ax] ?? ax}${arrow}`);
      }
      v.persona.traits = { ...v.persona.traits, ...reform.persona.traits };
    }
    if (reform.persona?.values) {
      v.persona.values = reform.persona.values;
      changes.push(`信条「${reform.persona.values.join('・') || 'なし'}」`);
    }
    if (reform.persona?.speechStyle) {
      v.persona.speechStyle = reform.persona.speechStyle;
      changes.push(`口調「${reform.persona.speechStyle}」`);
    }
    if (reform.appearance) {
      if (reform.appearance.body) {
        changes.push(`体→${reform.appearance.body}`);
        v.appearance.body = reform.appearance.body;
      }
      if (reform.appearance.descriptors) v.appearance.descriptors = reform.appearance.descriptors;
    }
    if (reform.emotion) v.emotion = { ...v.emotion, ...reform.emotion };
    v.reformCount += 1;
    return `${v.name} は教育で作り替えられた: ${changes.join(' / ') || '微調整'} (${reform.rationale})`;
  }

  /**
   * 日末の住民経済決済 (§15)。生存住民に 収入 → 趣味消費 → 推し送金 を適用し、
   * クズ化判定・たかりを行う。server が advance フェーズでログ/たかり表示に使う。
   * ブラックボックスエンジン (LLM 非依存の決定的アルゴリズム)。
   */
  settleEconomy(): EconomySettlement {
    return settleEconomy(this.world.villagers.values(), this.rng);
  }

  // --- フィールドアイテム (§16) -------------------------------------------------

  /**
   * フィールドにアイテムを配置する (§16)。'random' は precious/drug に解決し、ランダムな空きマスに置く。
   * カルマ消費は呼び出し側 (server) で行わない = 無料・ランダム配布。
   */
  placeItem(choice: ItemKindChoice): FieldItem {
    this.itemCount += 1;
    const kind = resolveItemKind(choice, this.rng);
    const position = {
      x: Math.floor(this.rng() * this.world.config.gridWidth),
      y: Math.floor(this.rng() * this.world.config.gridHeight),
    };
    const item: FieldItem = { id: `item_${this.itemCount}`, kind, position };
    this.world.items.push(item);
    return item;
  }

  /**
   * 推しに直接アイテムを送る (§16)。フィールドを介さず対象へ即適用する。
   * 対象が不在/退場なら null。
   */
  giveChampionItem(choice: ItemKindChoice, championId: string): { kind: FieldItemKind; name: string } | null {
    const v = this.world.villagers.get(championId);
    if (!v || !v.alive) return null;
    const kind = resolveItemKind(choice, this.rng);
    applyItemEffect(v, kind);
    return { kind, name: v.name };
  }

  /** 日末: フィールド上のアイテムを最寄りの住民が拾う (§16, 取り残しの掃除)。 */
  collectItems(): ItemPickup[] {
    return collectFieldItems(this.world);
  }

  /**
   * セグメントごとのアイテム回収 (§v1.4-A 体感即時化)。最寄りの起きている住民が
   * 1 歩ずつ取りに歩き、手が届いたら拾う。server が kisho の各 tick で呼ぶ。
   */
  tickItems(): ItemPickup[] {
    return stepItemPickups(this.world);
  }

  /** 日末の生活イベント (結婚/出産)。確率は option 既定 0 (= テスト不変)。 */
  lifeEvents(): LifeEvents {
    const out: LifeEvents = { marriages: [], births: [] };
    const alive = aliveVillagers(this.world);

    if (this.rng() < this.marriageChance) {
      const singles = alive.filter((v) => v.partnerId === null && !v.madman);
      if (singles.length >= 2) {
        const a = singles[Math.floor(this.rng() * singles.length)];
        const rest = a ? singles.filter((x) => x.id !== a.id) : [];
        const b = rest[Math.floor(this.rng() * rest.length)];
        if (a && b) {
          a.partnerId = b.id;
          b.partnerId = a.id;
          out.marriages.push({ a: a.id, b: b.id, aName: a.name, bName: b.name });
        }
      }
    }

    if (this.rng() < this.birthChance && alive.length < this.maxPopulation) {
      const reps = alive.filter(
        (v) => v.partnerId !== null && (this.world.villagers.get(v.partnerId)?.alive ?? false) && v.id < v.partnerId,
      );
      const p1 = reps[Math.floor(this.rng() * reps.length)];
      const p2 = p1?.partnerId ? this.world.villagers.get(p1.partnerId) : undefined;
      if (p1 && p2) {
        const child = this.spawnChild(p1, p2);
        out.births.push({ childId: child.id, childName: child.name, parents: `${p1.name}と${p2.name}` });
      }
    }
    return out;
  }

  /** 夫婦から子を 1 体出生 (気質はブレンド)。 */
  private spawnChild(p1: Villager, p2: Villager): Villager {
    this.bornCount += 1;
    const traits: Partial<Record<PersonalityAxis, number>> = {};
    for (const ax of PERSONALITY_AXES) {
      traits[ax] = clamp01((p1.persona.traits[ax] + p2.persona.traits[ax]) / 2 + (this.rng() - 0.5) * 0.2);
    }
    const child = createVillager({
      id: `born_${this.bornCount}`,
      name: `${p1.name}の子${this.bornCount}`,
      position: {
        x: Math.floor(this.rng() * this.world.config.gridWidth),
        y: Math.floor(this.rng() * this.world.config.gridHeight),
      },
      species: this.rng() < 0.5 ? p1.species : p2.species,
      activity: this.rng() < 0.5 ? p1.activity : p2.activity,
      traits,
      origin: 'born',
    });
    this.world.villagers.set(child.id, child);
    return child;
  }

  /** 日を進める。月の日数を超えたら月遷移 (= 実 1 日境界の大きな転換)。 */
  advanceDay(): AdvanceDayResult {
    if (this.world.phase !== 'advance') throw new Error(`advanceDay in phase ${this.world.phase}`);
    const cal = this.world.calendar;
    this.world.term += 1;
    // 神隠し (§v1.3-A ⑰) の一時退避が期限切れ (hiddenUntilTerm <= 新ターム) になったら村へ復帰させる。
    for (const v of this.world.villagers.values()) {
      if (v.hiddenUntilTerm !== undefined && v.hiddenUntilTerm <= this.world.term) {
        delete v.hiddenUntilTerm;
      }
    }
    cal.segment = 0;
    let monthRolled = false;
    cal.dayOfMonth += 1;
    if (cal.dayOfMonth > cal.daysInMonth) {
      monthRolled = true;
      cal.dayOfMonth = 1;
      cal.month += 1;
      if (cal.month > 12) {
        cal.month = 1;
        cal.year += 1;
      }
      cal.daysInMonth = daysInMonth(cal.year, cal.month);
      cal.season = season(cal.month);
    }
    this.world.phase = 'idle';
    // 村長選挙 (§17): 補欠/通常選挙・世論調査更新を日末に進める。
    const mayor = tickMayor(this.world, this.mayorConfig);
    return { monthRolled, holiday: holidayName(cal.year, cal.month, cal.dayOfMonth), mayor };
  }

  /** 村長リコールを判定する (§17)。server の recallMayor コマンドから呼ぶ。 */
  recallMayor(): RecallResult {
    return recallMayorFn(this.world, this.rng, this.mayorConfig);
  }

  /**
   * 祝日にあたる日のイベントを (AI) で発火する (§4.7)。worldBrain が無ければ null。
   * 祝祭は村の評判をわずかに動かす (適用後 0..1 クランプ)。phase は変えない。
   */
  async fireHolidayEvent(holiday: string): Promise<HolidayEvent | null> {
    if (!this.worldBrain) return null;
    const event = await this.worldBrain.holidayEvent({
      holiday,
      calendar: this.world.calendar,
      reputation: this.world.reputation,
      villagers: aliveVillagers(this.world),
    });
    for (const virtue of VIRTUES) {
      const delta = event.reputationDelta[virtue];
      if (delta !== undefined) {
        this.world.reputation[virtue] = clamp01(this.world.reputation[virtue] + delta);
      }
    }
    return event;
  }

  // --- 日末: 世界側 LLM 評価 (徳目評判更新 + 個体性格更新 + 偏り出生) ---
  // phase は変えない (server が advance フェーズで advanceDay の前に呼ぶ)。
  async evaluateDay(): Promise<DayEvaluation | null> {
    if (!this.worldBrain || !this.dayOutcome) return null;
    const outcome = this.dayOutcome;

    const defendant = this.world.villagers.get(outcome.defendantId);
    if (!defendant) {
      // 被告がワールドから消えている = 状態不整合。無言フォールバックせず捕捉を破棄する。
      this.dayOutcome = null;
      throw new Error(`evaluateDay: 被告が見つかりません: ${outcome.defendantId}`);
    }

    const involved: Villager[] = [];
    for (const id of outcome.incident.involved) {
      const v = this.world.villagers.get(id);
      if (v) involved.push(v);
    }

    const ctx: WorldEvalContext = {
      reputation: this.world.reputation,
      verdict: outcome.verdict,
      defendant,
      incident: outcome.incident,
      involved,
      calendar: this.world.calendar,
    };
    const evaluation = await this.worldBrain.evaluateDay(ctx);

    // 徳目評判 (村レーダー) を加算・クランプ。
    for (const virtue of VIRTUES) {
      const delta = evaluation.reputationDelta[virtue];
      if (delta !== undefined) {
        this.world.reputation[virtue] = clamp01(this.world.reputation[virtue] + delta);
      }
    }

    // 個体性格 (気質6軸) を加算・クランプ (存在する個体のみ)。
    for (const vd of evaluation.villagerDeltas) {
      const villager = this.world.villagers.get(vd.villager);
      if (!villager) continue;
      for (const axis of PERSONALITY_AXES) {
        const delta = vd.personalityDelta[axis];
        if (delta !== undefined) {
          villager.persona.traits[axis] = clamp01(villager.persona.traits[axis] + delta);
        }
      }
    }

    // 村ベクトルに偏った新個体を出生。
    if (evaluation.spawn > 0) this.spawnBiased(evaluation.spawn);

    this.dayOutcome = null;
    return evaluation;
  }

  /** 村の徳目評判を基準性格にした新個体を n 体出生する (maxPopulation 未満の範囲)。 */
  private spawnBiased(n: number): void {
    const base = personalityFromVirtue(this.world.reputation);
    for (let i = 0; i < n; i += 1) {
      if (aliveVillagers(this.world).length >= this.maxPopulation) break;
      const traits: Partial<Record<PersonalityAxis, number>> = {};
      for (const axis of PERSONALITY_AXES) {
        traits[axis] = clamp01(base[axis] + (this.rng() - 0.5) * 0.3);
      }
      this.bornCount += 1;
      const species = SPAWN_SPECIES[Math.floor(this.rng() * SPAWN_SPECIES.length)] ?? '猫';
      const activity = SPAWN_ACTIVITIES[Math.floor(this.rng() * SPAWN_ACTIVITIES.length)] ?? 'diurnal';
      const position = {
        x: Math.floor(this.rng() * this.world.config.gridWidth),
        y: Math.floor(this.rng() * this.world.config.gridHeight),
      };
      const villager = createVillager({
        id: `born_${this.bornCount}`,
        name: `新入り${this.bornCount}`,
        position,
        species,
        activity,
        traits,
        origin: 'born',
      });
      this.world.villagers.set(villager.id, villager);
    }
  }
}
