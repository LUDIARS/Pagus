// 起承転結ステートマシン。World と Brain を保持し、フェーズを 1 ステップずつ進める。
// 1 日 = 1 ターム = 12 セグメント。時間制御 (segmentRealMs のペース) は server が所有し、
// 本クラスは純粋な遷移ロジックを提供する。

import type { World, Villager, VillagerId, GridPos, Incident, TrialState, Reform, Verdict, ActivityPattern, IncidentDesign, InfoItem, MartialMode, ScheduledParty, ScheduledPartyKind, MoralDial } from './types/index.js';
import type { Brain, ActionDecision, EnvironmentView } from './brain.js';
import { aliveVillagers, awakeVillagers, environmentView, clampPos, bumpEventParam } from './world.js';
import { ensureTownResidents, changeHousing } from './town-residency.js';
import { advanceTownConstruction } from './town-construction.js';
import { residentDailyTree } from './resident-daily-tree.js';
import { fateTree, manipulationTree } from './resident-trial-tree.js';
import { residentSpeech } from './resident-speech-tree.js';
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
  setPlaceState,
  pruneExpiredPlaceStates,
  fanFlames as fanFlamesFn,
  DEFAULT_INTERVENTION,
  type InterventionConfig,
  type HeckleSide,
  type HeckleResult,
  type TestifyOutcome,
  type GiftKind,
  type GiftResult,
  type SpotResult,
  type FanFlamesResult,
} from './interventions.js';
import { defaultBehaviorRules } from './behavior-rules.js';
import {
  addThread,
  decayThreads,
  heatThreadsInvolving,
  resolveThread,
  DEFAULT_PLOT,
  type PlotConfig,
  type AddThreadInput,
} from './plot-threads.js';
import { pickArcTheme, DEFAULT_ARCS, type ArcRule, type ArcPick } from './incident-arc.js';
import { recordEducation, PART_LABELS } from './education-profile.js';
import { finalizeResidentAction } from './resident-goals.js';
import { advanceNarrative, rememberIncident, beginAftermath, suppressesOrganicIncident } from './narrative-director.js';
import { playMinorIncident, DEFAULT_MINOR, type MinorConfig } from './minor-incident.js';
import {
  composeWitnesses,
  maybeReveal,
  DEFAULT_TRIAL_COMPOSE,
  type TrialComposeConfig,
  type RevealResult,
} from './trial-composer.js';
import type { PlotThread, TrialWitness } from './types/index.js';
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
import { addResidentHistory, assignVillageName, connectNewVillager, generateUniqueVillagerName, pickVillageNamer, type VillagerNamingRecord } from './villager-gacha.js';
import { relationshipRoutineFor, type LifeRelationshipKind } from './life-profile.js';

export type IdGen = () => string;

const TRIAL_FOOLISH_ROUNDS = 1;
const TRIAL_FATE_ROUNDS = 2;

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

/** 復元した world.plotThreads の id (thread_N) から最大番号を求める (§v1.4-B, 通し番号の続き)。 */
function maxThreadIndex(threads: PlotThread[]): number {
  let max = 0;
  for (const t of threads) {
    const n = Number(t.id.replace(/^thread_/, ''));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

/** 出生どうぶつの種の候補。 */
const SPAWN_SPECIES = ['猫', '兎', '梟', '熊', '栗鼠'] as const;
/** 出生どうぶつの活動特性の候補。 */
const SPAWN_ACTIVITIES: readonly ActivityPattern[] = ['diurnal', 'nocturnal', 'crepuscular', 'always'];
const REL_HATE_THRESHOLD = -35;
const REL_LIKE_THRESHOLD = 45;
/** 夫婦が日課で家族の時間を過ごした痕跡。日末の出生判定を少し押し上げる。 */
export const FAMILY_TIME = 'familyTime';

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
  /** 火種 (§v1.4-B) のチューニング。省略時は DEFAULT_PLOT。 */
  plotConfig?: PlotConfig;
  /** 事件アークの派生表 (§v1.4-B)。省略時は DEFAULT_ARCS (server は data/incident-arcs.json を注入可)。 */
  incidentArcs?: ArcRule[];
  /** 小騒動 (§v1.4-B) のチューニング。省略時は DEFAULT_MINOR。 */
  minorConfig?: MinorConfig;
  /** 裁判バリエーション (§v1.4-B) のチューニング。省略時は DEFAULT_TRIAL_COMPOSE。 */
  trialComposeConfig?: TrialComposeConfig;
  /** スナップショット復元時の火種通し番号 (thread_N 衝突回避)。既定 = 既存 id の最大から続ける。 */
  threadCount?: number;
  /** モラルダイヤル (§v1.4-D)。wholesome では死刑が無効になる。既定 'balanced'。 */
  moral?: MoralDial;
  /**
   * 日常決定のフック (§v1.4-C shadow sampling)。kishoTick の各決定を server が観測し、
   * サンプリングして教師 LLM と比較する。sim は呼ぶだけで確率や比較を知らない。
   */
  onDailyDecision?: (villager: Villager, env: EnvironmentView, decision: ActionDecision) => void;
}

/** 日末の生活イベント (結婚/出産)。server がログ表示する。 */
export interface LifeEvents {
  marriages: Array<{ a: VillagerId; b: VillagerId; aName: string; bName: string }>;
  births: Array<{ childId: VillagerId; childName: string; parents: string }>;
}

export interface PartyEventResult {
  party: ScheduledParty;
  narrative: string;
  incidentDay: number | null;
  incidentSeed: string | null;
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

export interface TrialRepairResult {
  repaired: boolean;
  messages: string[];
}

export interface PlayerStatementResolution {
  reactions: Array<{ villagerId: VillagerId; name: string; supports: boolean; line: string }>;
  verdict: Verdict;
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
  /** 日末の減衰で消えた火種 (§v1.4-B)。 */
  burntThreads: PlotThread[];
  /** 新しい日が祝日ならその名前。 */
  holiday: string | null;
  /** 村長選挙イベント (§17, 起きた時のみ)。server がログ。 */
  mayor: MayorEvent | null;
}

export interface IncidentNaming extends VillagerNamingRecord {}

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
  /** 火種 (§v1.4-B) のチューニング。 */
  private readonly plotConfig: PlotConfig;
  /** 事件アークの派生表 (§v1.4-B)。 */
  private readonly incidentArcs: ArcRule[];
  /** 小騒動 (§v1.4-B) のチューニング。 */
  private readonly minorConfig: MinorConfig;
  /** 裁判バリエーション (§v1.4-B) のチューニング。 */
  private readonly trialComposeConfig: TrialComposeConfig;
  /** 火種の通し番号 (thread_N)。復元 world の既存 id 最大から続ける。 */
  private threadCount: number;
  /** モラルダイヤル (§v1.4-D)。 */
  private readonly moral: MoralDial;
  /** 日常決定のフック (§v1.4-C shadow sampling)。 */
  private readonly onDailyDecision: ((villager: Villager, env: EnvironmentView, decision: ActionDecision) => void) | null;
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
    this.plotConfig = opts.plotConfig ?? DEFAULT_PLOT;
    this.incidentArcs = opts.incidentArcs ?? DEFAULT_ARCS;
    this.minorConfig = opts.minorConfig ?? DEFAULT_MINOR;
    this.trialComposeConfig = opts.trialComposeConfig ?? DEFAULT_TRIAL_COMPOSE;
    this.threadCount = opts.threadCount ?? maxThreadIndex(world.plotThreads);
    this.moral = opts.moral ?? 'balanced';
    this.onDailyDecision = opts.onDailyDecision ?? null;
    // 村長 (§17): 復元時は world.mayorId を尊重し、未設定なら初回選挙で人気の村人を据える。
    if (world.mayorId === null && aliveVillagers(world).length > 0) {
      electMayor(world, this.mayorConfig);
    }
    // base ルールの補完 (§v1.4-A'): 復元した world.behaviorRules に、後から追加された
    // 組込み base ルール (例 base_defiled_place) が欠けていれば足す (id で冪等)。
    for (const base of defaultBehaviorRules()) {
      if (!world.behaviorRules.some((r) => r.id === base.id)) world.behaviorRules.push(base);
    }
    this.ensureSocialBonds();
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

  private todayKey(): string {
    const c = this.world.calendar;
    return `${c.year}-${c.month}-${c.dayOfMonth}`;
  }

  trialOpenedToday(): boolean {
    return this.world.trialDayKey === this.todayKey();
  }

  private markTrialOpened(): void {
    this.world.trialDayKey = this.todayKey();
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
      villagers: this.llmFocusVillagers(12),
      existingRules: this.world.behaviorRules,
      calendar: this.world.calendar,
      scheduledIncident: this.world.scheduledIncident,
    });
    this.ruleCount += 1;
    // id/source は呼び出し側で確定 (通し番号で衝突回避、source は haiku 固定)。
    const rule: BehaviorRule = { ...proposed, id: `rule_haiku_${this.ruleCount}`, source: 'haiku' };
    this.world.behaviorRules.push(rule);
    this.pruneRulesOverMax();
    return rule;
  }

  /**
   * 蒸留ルール (§v1.4-C) を追加する。replay ゲート通過後に server が呼ぶ。
   * source='distill'、id は rule_distill_N。上限超過はアトランダム由来 (haiku) から間引く。
   */
  addDistilledRule(proposed: BehaviorRule): BehaviorRule {
    this.ruleCount += 1;
    const rule: BehaviorRule = { ...proposed, id: `rule_distill_${this.ruleCount}`, source: 'distill' };
    this.world.behaviorRules.push(rule);
    this.pruneRulesOverMax();
    return rule;
  }

  /** ルール上限の間引き: haiku (探索由来) を先に、無ければ distill (蒸留由来) を捨てる。base は守る。 */
  private pruneRulesOverMax(): void {
    while (this.world.behaviorRules.length > this.rulesMax) {
      const haiku = this.world.behaviorRules.findIndex((r) => r.source === 'haiku');
      const idx = haiku >= 0 ? haiku : this.world.behaviorRules.findIndex((r) => r.source === 'distill');
      if (idx < 0) return; // base/card しか残っていなければ間引かない
      this.world.behaviorRules.splice(idx, 1);
    }
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
    if (this.trialOpenedToday()) return false;
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
    this.markTrialOpened();
    return {
      incidentId: incident.id,
      judge: { kind: 'nekomori' },
      candidates: [defendantId],
      stage: 'fate',
      pendingGroups: this.trialRoundGroups(TRIAL_FATE_ROUNDS),
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

  /**
   * 場所を荒らす/清める (§v1.4-A' spot)。その場の住民の感情が即時に動き、
   * 場所の状態が days ターム残って behavior-rule に効く。place が不正なら null。
   */
  spot(place: string, mode: 'defile' | 'bless', days: number): SpotResult | null {
    return setPlaceState(this.world, place, mode, days, this.interveneConfig);
  }

  /**
   * 噂の増幅 (§v1.4-A' fanFlames)。対象のプレイヤー由来の噂を近傍住民へ撒く。
   * 対象不在/噂なしなら null。
   */
  fanFlames(targetId: VillagerId): FanFlamesResult | null {
    return fanFlamesFn(this.world, targetId);
  }

  /** 失効した場所の状態を除去して返す (§v1.4-A', 日末)。server が advanceDay 後に呼ぶ。 */
  pruneExpiredPlaceStates(): SpotResult[] {
    return pruneExpiredPlaceStates(this.world);
  }

  // --- 火種 (§v1.4-B PlotThread) --------------------------------------------------

  /**
   * 火種を 1 件足す (§v1.4-B)。sim 内の生成点 (判決/和解/偽予言) と server の生成点
   * (推しの死/しきたり追加) の両方から呼ばれる。id は thread_N の通し番号。
   */
  addPlotThread(input: AddThreadInput): PlotThread {
    this.threadCount += 1;
    return addThread(this.world, input, `thread_${this.threadCount}`, this.plotConfig);
  }

  /** スナップショット保存用: 火種通し番号。 */
  getThreadCount(): number {
    return this.threadCount;
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
    // 偽予言は村を覆う噂の火種 (§v1.4-B) になる。
    this.addPlotThread({ kind: 'rumor', actors: [], heat: 0.5, note: `予言「${body}」が村をざわつかせている` });
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
  async scheduleMonthlyIncident(): Promise<(MonthlySchedule & { arcNote?: string }) | null> {
    if (!this.worldBrain) return null;
    const cal = this.world.calendar;
    // 事件アーク (§v1.4-B): 火種があれば派生表からテーマを選び、LLM には肉付けだけさせる。
    const arcPick: ArcPick | null = pickArcTheme(this.world, this.incidentArcs, this.rng);
    const ctx: Parameters<WorldBrain['scheduleMonthlyIncident']>[0] = {
      calendar: cal,
      reputation: this.world.reputation,
      villagers: this.llmFocusVillagers(12),
      villageRules: this.world.villageRules,
    };
    if (arcPick) {
      ctx.arcHint = {
        themeSeed: arcPick.themeSeed,
        threadNote: arcPick.thread.note,
        actorNames: arcPick.thread.actors.map((a) => a.name),
      };
    }
    const m = await this.worldBrain.scheduleMonthlyIncident(ctx);
    const dayOfMonth = Math.min(cal.daysInMonth, Math.max(1, Math.round(m.dayOfMonth)));
    this.world.scheduledIncident = {
      dayOfMonth,
      themeSeed: m.themeSeed,
      designed: false,
      fired: false,
      design: null,
      ...(arcPick ? { arcThreadId: arcPick.thread.id } : {}),
    };
    if (arcPick) return { dayOfMonth, themeSeed: m.themeSeed, arcNote: arcPick.thread.note };
    return { dayOfMonth, themeSeed: m.themeSeed };
  }

  /**
   * 事件前日: 世界側 LLM が事件を詳細デザインし、事件用キャラを生成して村に投入する (§12.3.2/3)。
   * scheduledIncident が無い/デザイン済み/worldBrain 無しなら null。
   * 加害者が解決できなければ throw (無言フォールバック禁止)。
   */
  async designScheduledIncident(): Promise<{ design: IncidentDesign; spawned: Villager[]; naming: IncidentNaming[] } | null> {
    const sched = this.world.scheduledIncident;
    if (!sched || sched.designed || !this.worldBrain) return null;

    // 連続犯の継続入力: 居座る過去の事件用キャラ。
    const survivingCulprits = aliveVillagers(this.world).filter((v) => v.origin === 'incident');
    const design = await this.worldBrain.designIncident({
      calendar: this.world.calendar,
      reputation: this.world.reputation,
      villagers: this.llmFocusVillagers(12, survivingCulprits.map((v) => v.id)),
      villageRules: this.world.villageRules,
      themeSeed: sched.themeSeed,
      survivingCulprits,
      plotThreads: this.world.plotThreads,
    });

    // 事件用キャラを spawn して村に追加する。
    const spawned: Villager[] = [];
    const naming: IncidentNaming[] = [];
    const finalCharacters = design.newCharacters.map((c) => ({ ...c }));
    for (const spec of design.newCharacters) {
      this.incidentCount += 1;
      const id = `incident_${this.incidentCount}`;
      const originalName = spec.name.trim();
      const assignedName = assignVillageName(this.world, spec.name, this.rng);
      const namedBy = assignedName !== originalName ? pickVillageNamer(this.world, id, this.rng) : null;
      if (namedBy) {
        naming.push({
          villagerId: id,
          originalName,
          assignedName,
          namedById: namedBy.id,
          namedByName: namedBy.name,
        });
      }
      finalCharacters[spawned.length]!.name = assignedName;
      const seed: Parameters<typeof createVillager>[0] = {
        id,
        name: assignedName,
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
      const named = naming.find((n) => n.villagerId === v.id);
      addResidentHistory(this.world, v, {
        origin: 'incident',
        archetype: spec.role,
        ...(named ? { originalName: named.originalName, namedById: named.namedById, namedByName: named.namedByName } : {}),
      });
      connectNewVillager(this.world, v, this.rng);
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
      newCharacters: finalCharacters,
      involvedIds,
      perpetratorId,
      scapegoat: design.scapegoat,
      framedTargetId: design.framedTargetId,
    };
    sched.design = finalDesign;
    sched.designed = true;
    return { design: finalDesign, spawned, naming };
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
    if (this.trialOpenedToday()) return false;
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

  scheduleMonthlyParty(): ScheduledParty | null {
    const alive = aliveVillagers(this.world).filter((v) => !v.madman);
    if (alive.length === 0) {
      this.world.scheduledParty = null;
      return null;
    }
    const cal = this.world.calendar;
    const reserved = this.world.scheduledIncident?.dayOfMonth ?? -1;
    const days: number[] = [];
    for (let d = 2; d <= cal.daysInMonth; d += 1) {
      if (d !== reserved && d !== reserved - 1) days.push(d);
    }
    const dayOfMonth = days[Math.floor(this.rng() * days.length)] ?? Math.min(cal.daysInMonth, 2);
    const party = this.buildParty(dayOfMonth, alive);
    this.world.scheduledParty = party;
    return party;
  }

  fireScheduledParty(): PartyEventResult | null {
    const party = this.world.scheduledParty;
    if (!party || party.fired) return null;
    if (this.world.calendar.dayOfMonth !== party.dayOfMonth) return null;
    if (this.world.phase !== 'kisho' && this.world.phase !== 'idle') return null;
    if (this.world.incident || this.world.trial) return null;

    party.fired = true;
    const participants = party.participantIds
      .map((id) => this.world.villagers.get(id))
      .filter((v): v is Villager => v !== undefined && v.alive);
    const names = participants.map((v) => v.name).join('、') || '村のみんな';
    this.world.reputation.vitality = clamp01(this.world.reputation.vitality + 0.04);
    this.world.reputation.benevolence = clamp01(this.world.reputation.benevolence + 0.03);

    if (party.kind === 'wedding' && participants.length >= 2) {
      const a = participants[0]!;
      const b = participants[1]!;
      if (a.partnerId === null && b.partnerId === null) {
        a.partnerId = b.id;
        b.partnerId = a.id;
      }
      this.bindPair(a, b, 'spouse');
    }

    for (let i = 0; i < participants.length; i += 1) {
      for (let j = i + 1; j < participants.length; j += 1) {
        this.adjustRelationship(participants[i]!, participants[j]!, 14, `${party.title}で距離が近づいた`);
        this.adjustRelationship(participants[j]!, participants[i]!, 14, `${party.title}で距離が近づいた`);
      }
    }

    const avgAggression =
      participants.reduce((sum, v) => sum + v.persona.traits.aggression + v.stress * 0.08, 0) / Math.max(1, participants.length);
    const troubleChance = Math.min(0.55, 0.08 + this.world.reputation.malice * 0.35 + avgAggression * 0.18);
    let incidentDay: number | null = null;
    let incidentSeed: string | null = null;
    if (this.rng() < troubleChance) {
      for (const v of participants) v.stress += 1;
      incidentSeed = `${party.title}の席で起きた不和。参加者: ${names}`;
      incidentDay = this.plantPartyIncident(incidentSeed);
      if (incidentDay !== null) party.incidentPlanted = true;
    }

    const narrative =
      incidentDay === null
        ? `${party.title}: ${names}が集まり、村に穏やかな熱が残った`
        : `${party.title}: ${names}の祝いの席に不穏な火種が残り、${incidentDay}日に事件の予兆となった`;
    return { party, narrative, incidentDay, incidentSeed };
  }

  private buildParty(dayOfMonth: number, alive: Villager[]): ScheduledParty {
    const singles = alive.filter((v) => v.partnerId === null);
    let kind: ScheduledPartyKind = 'harvest';
    if (singles.length >= 2 && this.rng() < 0.28) kind = 'wedding';
    else if (this.world.residentHistory.some((h) => h.joinedTerm >= this.world.term - 3)) kind = 'welcome';
    else if (this.rng() < 0.25) kind = 'memorial';

    let participantIds: VillagerId[] = [];
    if (kind === 'wedding') {
      participantIds = singles.slice(0, 2).map((v) => v.id);
    } else if (kind === 'welcome') {
      const newest = [...this.world.residentHistory].sort((a, b) => b.joinedTerm - a.joinedTerm)[0];
      const guest = newest ? this.world.villagers.get(newest.id) : undefined;
      participantIds = guest && guest.alive ? [guest.id] : [];
    }
    if (participantIds.length === 0) {
      participantIds = [...alive]
        .sort(() => this.rng() - 0.5)
        .slice(0, Math.min(4, alive.length))
        .map((v) => v.id);
    } else {
      for (const v of alive) {
        if (participantIds.length >= Math.min(4, alive.length)) break;
        if (!participantIds.includes(v.id)) participantIds.push(v.id);
      }
    }

    const title =
      kind === 'wedding'
        ? '結婚祝い'
        : kind === 'welcome'
          ? '歓迎会'
          : kind === 'memorial'
            ? '追悼の集い'
            : '収穫祭';
    return { dayOfMonth, kind, title, participantIds, fired: false, incidentPlanted: false };
  }

  private ensureSocialBonds(): void {
    const alive = aliveVillagers(this.world).filter((v) => !v.madman);
    const aliveIds = new Set(alive.map((v) => v.id));
    for (const v of alive) {
      if (!v.partnerId || v.id > v.partnerId) continue;
      const partner = this.world.villagers.get(v.partnerId);
      if (partner && partner.alive && aliveIds.has(partner.id)) this.bindPair(v, partner, 'spouse');
    }

    const hasSpouse = this.world.relationships.some((r) => r.kind === 'spouse' && aliveIds.has(r.from) && aliveIds.has(r.to));
    if (!hasSpouse && alive.length >= 4) {
      const pair = this.bestBondPair(alive.filter((v) => v.partnerId === null));
      if (pair) {
        const [a, b] = pair;
        a.partnerId = b.id;
        b.partnerId = a.id;
        this.bindPair(a, b, 'spouse');
      }
    }

    const hasRomance = this.world.relationships.some((r) => r.kind === 'romance' && aliveIds.has(r.from) && aliveIds.has(r.to));
    if (!hasRomance && alive.length >= 4) {
      const singles = alive.filter((v) => v.partnerId === null);
      const pair = this.bestBondPair(singles.length >= 2 ? singles : alive.filter((v) => v.partnerId === null));
      if (pair) this.bindPair(pair[0], pair[1], 'romance');
    }
  }

  private bestBondPair(candidates: Villager[]): [Villager, Villager] | null {
    const pool = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
    let best: { pair: [Villager, Villager]; score: number; key: string } | null = null;
    for (let i = 0; i < pool.length; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1) {
        const a = pool[i]!;
        const b = pool[j]!;
        const score = this.bondScore(a, b);
        const key = `${a.id}:${b.id}`;
        if (!best || score > best.score || (score === best.score && key < best.key)) {
          best = { pair: [a, b], score, key };
        }
      }
    }
    return best?.pair ?? null;
  }

  private bondScore(a: Villager, b: Villager): number {
    const traits = a.persona.traits;
    const other = b.persona.traits;
    const closeness =
      (1 - Math.abs(traits.sociability - other.sociability)) * 14
      + (1 - Math.abs(traits.discipline - other.discipline)) * 10
      + (1 - Math.abs(traits.curiosity - other.curiosity)) * 8
      - Math.abs(traits.aggression - other.aggression) * 10;
    return closeness + this.averageAffinity(a.id, b.id);
  }

  private averageAffinity(a: VillagerId, b: VillagerId): number {
    const ab = this.world.relationships.find((r) => r.from === a && r.to === b)?.affinity;
    const ba = this.world.relationships.find((r) => r.from === b && r.to === a)?.affinity;
    const values = [ab, ba].filter((v): v is number => v !== undefined);
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  private bindPair(a: Villager, b: Villager, kind: LifeRelationshipKind): void {
    const affinity = kind === 'spouse' ? 82 : 68;
    this.bindRelationship(a, b, kind, affinity);
    this.bindRelationship(b, a, kind, affinity);
  }

  private bindRelationship(from: Villager, to: Villager, kind: LifeRelationshipKind, affinity: number): void {
    let rel = this.world.relationships.find((r) => r.from === from.id && r.to === to.id);
    const note = this.relationshipNote(from, to, kind);
    if (!rel) {
      rel = { from: from.id, to: to.id, affinity, hates: false, note, kind, sinceTerm: this.world.term };
      this.world.relationships.push(rel);
      return;
    }
    rel.affinity = Math.max(rel.affinity, affinity);
    rel.hates = false;
    rel.note = note;
    rel.kind = kind;
    rel.sinceTerm ??= this.world.term;
  }

  private relationshipNote(from: Villager, to: Villager, kind: LifeRelationshipKind): string {
    return kind === 'spouse'
      ? `夫婦: ${from.name} と ${to.name} は生活を共にしている`
      : `恋愛: ${from.name} は ${to.name} を大切に思っている`;
  }

  private adjustRelationship(from: Villager, to: Villager, delta: number, note: string): void {
    let rel = this.world.relationships.find((r) => r.from === from.id && r.to === to.id);
    if (!rel) {
      rel = { from: from.id, to: to.id, affinity: 0, hates: false, note };
      this.world.relationships.push(rel);
    }
    rel.affinity = Math.max(-100, Math.min(100, rel.affinity + delta));
    if (rel.kind === 'spouse' || rel.kind === 'romance') {
      rel.hates = false;
      if (!rel.note.startsWith('夫婦:') && !rel.note.startsWith('恋愛:')) rel.note = this.relationshipNote(from, to, rel.kind);
      return;
    }
    rel.hates = rel.affinity <= REL_HATE_THRESHOLD;
    rel.note = rel.hates
      ? `${from.name}は${to.name}を警戒している`
      : rel.affinity >= REL_LIKE_THRESHOLD
        ? `${from.name}は${to.name}に心を許している`
        : note;
  }

  private plantPartyIncident(themeSeed: string): number | null {
    const current = this.world.calendar.dayOfMonth;
    const dayOfMonth = Math.min(this.world.calendar.daysInMonth, current + 1 + Math.floor(this.rng() * 2));
    if (dayOfMonth <= current) return null;
    const existing = this.world.scheduledIncident;
    if (existing && !existing.fired && existing.dayOfMonth > current) return null;
    this.world.scheduledIncident = {
      dayOfMonth,
      themeSeed,
      designed: false,
      fired: false,
      design: null,
    };
    return dayOfMonth;
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
    ensureTownResidents(this.world);
    advanceTownConstruction(this.world);
    const awakeIds = new Set(awakeVillagers(this.world).map((v) => v.id));
    for (const v of aliveVillagers(this.world)) {
      if (awakeIds.has(v.id)) continue;
      // 睡眠帯も帰宅経路は進めるが、行動概要 (actions) は起きて行動した住民のみ (§KishoTickResult)。
      const decision = residentDailyTree(this.world, v, () => { throw new Error('Sleeping resident entered waking behavior'); });
      this.applyDecision(v, decision, []);
    }
    const episode = this.trialOpenedToday() ? null : advanceNarrative(this.world, this.moral);
    if (episode) {
      const incident = this.startIncident(episode.perpetrator, { description: episode.story.setup, involved: episode.involved }, { origin: 'designed' });
      incident.story = episode.story;
      this.world.incident = incident;
      this.world.phase = 'sho';
      return { actions: [{ villager: episode.perpetrator, action: episode.story.setup }], incidentStarted: true };
    }

    const remaining = this.world.config.segmentsPerDay - this.world.calendar.segment;
    const directives = new Map((this.director?.planSegment(this.world, remaining) ?? []).map((d) => [d.actor, d]));
    for (const villager of awakeVillagers(this.world)) {
      const env = environmentView(this.world, villager);
      const decision = residentDailyTree(this.world, villager, () => this.withRelationshipRoutine(villager, env, this.daily.decide(villager, env, directives.get(villager.id) ?? null)));
      this.onDailyDecision?.(villager, env, decision); // shadow sampling (§v1.4-C)
      if (this.applyDecision(villager, decision, actions)) return { actions, incidentStarted: true };
    }
    return { actions, incidentStarted: false };
  }

  private withRelationshipRoutine(actor: Villager, env: EnvironmentView, decision: ActionDecision): ActionDecision {
    if (decision.triggersIncident) return decision;
    const related = this.activeRelationshipFor(actor);
    if (!related) return decision;
    const chance = this.relationshipRoutineChance(env.timeOfDay, related.kind);
    if (this.rng() >= chance) return decision;

    if (related.kind === 'spouse' && (env.timeOfDay === 'evening' || env.timeOfDay === 'night')) {
      bumpEventParam(actor, FAMILY_TIME, 1);
      bumpEventParam(related.partner, FAMILY_TIME, 1);
    }

    return {
      ...decision,
      move: this.stepToward(actor.position, related.partner.position),
      action: relationshipRoutineFor(actor, related.partner, env, related.kind),
      triggersIncident: false,
      incidentSeed: null,
      relationshipEffects: [
        ...(decision.relationshipEffects ?? []),
        { kind: related.kind === 'spouse' ? 'good' : 'chat', targetIds: [related.partner.id] },
      ],
    };
  }

  private relationshipRoutineChance(timeOfDay: EnvironmentView['timeOfDay'], kind: LifeRelationshipKind): number {
    const eveningOrNight = timeOfDay === 'evening' || timeOfDay === 'night';
    if (kind === 'spouse') return eveningOrNight ? 0.42 : 0.14;
    return eveningOrNight ? 0.3 : 0.1;
  }

  private activeRelationshipFor(actor: Villager): { partner: Villager; kind: LifeRelationshipKind } | null {
    if (actor.partnerId) {
      const spouse = this.world.villagers.get(actor.partnerId);
      if (spouse?.alive) return { partner: spouse, kind: 'spouse' };
    }
    const rel = this.world.relationships.find((r) => r.from === actor.id && r.kind === 'romance');
    const partner = rel ? this.world.villagers.get(rel.to) : undefined;
    if (partner?.alive) return { partner, kind: 'romance' };
    return null;
  }

  private stepToward(from: GridPos, to: GridPos): GridPos {
    return clampPos(this.world, {
      x: from.x + Math.sign(to.x - from.x),
      y: from.y + Math.sign(to.y - from.y),
    });
  }

  /** 行動を適用。事件が発火したら true を返し phase を sho にする。 */
  private applyDecision(
    actor: Villager,
    proposal: ActionDecision,
    actions: KishoTickResult['actions'],
  ): boolean {
    // Preserve a breathing interval and a readable omen. Explicit player incitement still wins.
    if (!proposal.forcedTrigger && proposal.triggersIncident && suppressesOrganicIncident(this.world)) {
      proposal = { ...proposal, triggersIncident: false, incidentSeed: null };
    }
    const decision = finalizeResidentAction(this.world, actor, proposal);
    if (decision.move) actor.position = clampPos(this.world, decision.move);
    actor.emotion = decision.newEmotion;
    this.applyRelationshipEffects(actor, decision);
    this.applySideEffects(actor, decision);
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
      // 小騒動 (§v1.4-B): 日常由来の事件化の一部は裁判に至らない寸劇として即時決着する。
      // 大事件 (月次) の谷を埋める山になり、遺恨が残れば火種 (rumor) が立つ。
      // 扇動 (forceNext/forceFor) 由来はカルマを払った操作なのでフル事件へ直行させる。
      const firstVictim = victimIds[0] ? this.world.villagers.get(victimIds[0]) : undefined;
      if (!decision.forcedTrigger && firstVictim && this.rng() < this.minorConfig.minorChance) {
        const minor = playMinorIncident(actor, firstVictim, this.rng, this.minorConfig);
        for (const line of minor.lines) actions.push({ villager: actor.id, action: line });
        if (minor.residue) {
          this.addPlotThread({
            kind: 'rumor',
            actors: [
              { id: actor.id, name: actor.name },
              { id: firstVictim.id, name: firstVictim.name },
            ],
            heat: 0.4,
            note: `${actor.name}と${firstVictim.name}の諍いがくすぶっている`,
          });
        }
        heatThreadsInvolving(this.world, [actor.id, firstVictim.id], this.plotConfig);
        return false;
      }
      this.world.incident = this.startIncident(actor.id, seed);
      this.world.phase = 'sho';
      return true;
    }
    return false;
  }

  private applyRelationshipEffects(actor: Villager, decision: ActionDecision): void {
    for (const effect of decision.relationshipEffects ?? []) {
      for (const targetId of effect.targetIds) {
        if (targetId === actor.id) continue;
        const target = this.world.villagers.get(targetId);
        if (!target || !target.alive) continue;
        if (effect.kind === 'harass') {
          bumpEventParam(target, 'townHarassment', 1);
          if ((target.eventParams['townHarassment'] ?? 0) >= 6 && target.townLife && target.townLife.housing !== 'isolated') {
            changeHousing(target, 'isolated', '繰り返される嫌がらせから逃れ、街はずれの離れで暮らしている');
          }
          const targetDrop = -Math.round(12 * this.relationshipVolatility(target) * (1 + target.persona.traits.kindness * 0.25));
          const actorDrop = -Math.round(4 * this.relationshipVolatility(actor) * (1 + actor.persona.traits.aggression * 0.35));
          this.adjustRelationship(target, actor, targetDrop, `${target.name}は${actor.name}の嫌がらせを忘れていない`);
          this.adjustRelationship(actor, target, actorDrop, `${actor.name}は${target.name}を疎ましく感じた`);
        } else {
          const base = effect.kind === 'good' ? 8 : 5;
          const actorGain = Math.round(base * this.relationshipVolatility(actor) * (1 + actor.persona.traits.kindness * 0.25));
          const targetGain = Math.round(base * this.relationshipVolatility(target) * (1 + target.persona.traits.sociability * 0.25));
          const note = effect.kind === 'good'
            ? `${actor.name}と${target.name}は良い出来事を共有した`
            : `${actor.name}と${target.name}は言葉を交わした`;
          this.adjustRelationship(actor, target, actorGain, note);
          this.adjustRelationship(target, actor, targetGain, note);
        }
      }
    }
  }

  private relationshipVolatility(v: Villager): number {
    const t = v.persona.traits;
    const raw = 0.65 + t.sociability * 0.45 + t.curiosity * 0.25 + t.aggression * 0.28 + t.ambition * 0.18 - t.discipline * 0.32 + Math.min(0.35, v.stress * 0.018);
    return Math.max(0.35, Math.min(1.8, raw));
  }

  /**
   * ルール評価が指示した副作用 (DSL v2, §v1.4-C) を適用する。
   * spreadInfo=最新の情報を最寄りの 1 体へ複製 / moveBias=対象へ 1 歩寄る (狂人からは離れる) /
   * wealthDelta=所持金の増減 (下限 0)。
   */
  private applySideEffects(actor: Villager, decision: ActionDecision): void {
    const fx = decision.sideEffects;
    if (!fx) return;
    if (fx.wealthDelta !== undefined) {
      actor.wealth = Math.max(0, actor.wealth + fx.wealthDelta);
    }
    if (fx.spreadInfo) {
      const newest = actor.information[actor.information.length - 1];
      if (newest) {
        const neighbor = aliveVillagers(this.world)
          .filter((v) => v.id !== actor.id)
          .sort(
            (a, b) =>
              Math.max(Math.abs(a.position.x - actor.position.x), Math.abs(a.position.y - actor.position.y)) -
              Math.max(Math.abs(b.position.x - actor.position.x), Math.abs(b.position.y - actor.position.y)),
          )[0];
        if (neighbor && !neighbor.information.some((i) => i.id === `${newest.id}_ripple_${neighbor.id}`)) {
          neighbor.information.push({
            id: `${newest.id}_ripple_${neighbor.id}`,
            text: `${actor.name}から聞いた: ${newest.text}`,
            source: 'observation',
            termAcquired: this.world.term,
          });
        }
      }
    }
    if (fx.moveBias) {
      let target: Villager | undefined;
      if (fx.moveBias === 'partner' && actor.partnerId) target = this.world.villagers.get(actor.partnerId);
      else if (fx.moveBias === 'admire' && actor.admireId) target = this.world.villagers.get(actor.admireId);
      else if (fx.moveBias === 'awayMadman') target = this.aliveMadman() ?? undefined;
      if (target && target.alive) {
        const away = fx.moveBias === 'awayMadman' ? -1 : 1;
        actor.position = clampPos(this.world, {
          x: actor.position.x + Math.sign(target.position.x - actor.position.x) * away,
          y: actor.position.y + Math.sign(target.position.y - actor.position.y) * away,
        });
      }
    }
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
    // 関係者が絡む火種は加熱される (§v1.4-B)。
    heatThreadsInvolving(this.world, [perpetrator, ...involved], this.plotConfig);
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
    rememberIncident(this.world, incident);
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
      term: this.world.term,
    });
    incident.steps.push({ perspective, action: step.action, damageDelta: step.damageDelta });
    incident.damage += step.damageDelta;

    // 事件が一線を越えたら裁判へ (和解より優先)。
    if (step.ended || incident.damage >= this.world.config.damageThreshold) {
      incident.resolved = true;
      if (this.trialOpenedToday()) {
        const perpName = this.world.villagers.get(incident.perpetrator)?.name ?? incident.perpetrator;
        this.addPlotThread({
          kind: 'rumor',
          actors: [{ id: incident.perpetrator, name: perpName }],
          heat: 0.28,
          note: `${perpName}の事件は今日二度目の裁判を避け、火種だけが残った`,
        });
        this.world.incident = null;
        this.world.phase = 'kisho';
        return { outcome: 'reconciled', secondaryVictim: null };
      }
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
      // 和解はめでたいが、くすぶる遺恨が火種 (§v1.4-B) として残る。
      const perpName = this.world.villagers.get(incident.perpetrator)?.name ?? incident.perpetrator;
      const v0 = incident.involved[0];
      const v0v = v0 ? this.world.villagers.get(v0) : undefined;
      this.addPlotThread({
        kind: 'rumor',
        actors: [
          { id: incident.perpetrator, name: perpName },
          ...(v0v ? [{ id: v0v.id, name: v0v.name }] : []),
        ],
        heat: 0.35,
        note: `${perpName}の諍いは和解したが、遺恨がくすぶる`,
      });
      this.world.incident = null;
      this.world.phase = 'kisho';
      return { outcome: 'reconciled', secondaryVictim };
    }

    return { outcome: 'ongoing', secondaryVictim };
  }

  private groupAxes(): PersonalityAxis[] {
    return [...groupByDominant(aliveVillagers(this.world), (v) => v.persona.traits).keys()];
  }

  private trialRoundGroups(rounds: number): PersonalityAxis[] {
    return this.groupAxes().slice(0, Math.max(1, rounds));
  }

  private votersOf(axis: PersonalityAxis): Villager[] {
    return aliveVillagers(this.world).filter((v) => dominantAxis(v.persona.traits) === axis);
  }

  private relatedVotersOf(axis: PersonalityAxis, incident: Incident): Villager[] {
    return this.votersOf(axis).filter((v) => this.isIncidentRelated(v, incident));
  }

  private isIncidentRelated(villager: Villager, incident: Incident): boolean {
    const relatedIds = this.incidentRelatedIds(incident);
    if (relatedIds.has(villager.id)) return true;
    return this.hasStrongRelationshipWithAny(villager.id, relatedIds);
  }

  private incidentRelatedIds(incident: Incident): Set<VillagerId> {
    const ids = new Set<VillagerId>([incident.perpetrator, ...incident.involved]);
    if (incident.framedTargetId) ids.add(incident.framedTargetId);
    return ids;
  }

  private hasStrongRelationshipWithAny(villagerId: VillagerId, targetIds: ReadonlySet<VillagerId>): boolean {
    for (const rel of this.world.relationships) {
      if (rel.affinity > REL_HATE_THRESHOLD && rel.affinity < REL_LIKE_THRESHOLD) continue;
      const direct = rel.from === villagerId && targetIds.has(rel.to);
      const reverse = rel.to === villagerId && targetIds.has(rel.from);
      if (direct || reverse) return true;
    }
    return false;
  }

  private llmFocusVillagers(limit: number, seedIds: VillagerId[] = []): Villager[] {
    const alive = aliveVillagers(this.world);
    const seeds = new Set<VillagerId>(seedIds);
    const ranked = alive
      .map((v) => ({ v, score: this.llmFocusScore(v, seeds) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.v.id.localeCompare(b.v.id));
    const focused = ranked.slice(0, limit).map(({ v }) => v);
    return focused.length > 0 ? focused : alive.slice(0, limit);
  }

  private llmFocusScore(villager: Villager, seedIds: ReadonlySet<VillagerId>): number {
    let score = 0;
    if (seedIds.has(villager.id)) score += 100;
    if (villager.madman) score += 25;
    if (this.world.mayorId === villager.id) score += 10;
    score += villager.reformCount * 8;
    score += Math.min(30, villager.stress * 3);
    score += Math.min(30, (villager.eventParams[REACTION_EXPOSURE] ?? 0) * 10);
    score += Math.min(18, (villager.eventParams['drug'] ?? 0) * 6);
    score += villager.persona.traits.aggression * 8;
    score += villager.persona.traits.ambition * 4;
    if (seedIds.size > 0 && this.hasStrongRelationshipWithAny(villager.id, seedIds)) score += 30;
    return score;
  }

  private openTrial(incident: Incident): TrialState {
    this.userVotes.clear();
    this.markTrialOpened();
    const trial: TrialState = {
      incidentId: incident.id,
      judge: { kind: 'nekomori' },
      candidates: [incident.perpetrator, ...incident.involved],
      stage: 'foolish',
      pendingGroups: this.trialRoundGroups(TRIAL_FOOLISH_ROUNDS),
      foolishVotes: {},
      defendant: null,
      fateVotes: { kill: 0, spare: 0 },
      votes: [],
      verdict: null,
    };
    // 目撃者 (§v1.4-B witness): 開廷時に傍観者が証言し foolish 票へ重みを乗せる。
    // 擦り付け (framed) があれば目撃者は framed を指し、冤罪に説得力が生まれる。
    composeWitnesses(this.world, incident, trial, this.rng, this.trialComposeConfig);
    return trial;
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
    this.applyUserVoteRelationshipEffect(trial, pick);
    this.userVotes.set(userId, { stage: trial.stage, pick });
  }

  private applyUserVoteRelationshipEffect(trial: TrialState, pick: string): void {
    const incident = this.world.incident;
    if (!incident) return;
    if (trial.stage === 'foolish') {
      const target = this.world.villagers.get(pick as VillagerId);
      if (!target?.alive) return;
      const related = this.incidentRelatedIds(incident);
      for (const observer of aliveVillagers(this.world).filter((v) => v.id !== target.id && related.has(v.id)).slice(0, 4)) {
        this.adjustRelationship(observer, target, -1, `裁判投票で${target.name}への疑いが増えた`);
      }
      return;
    }
    if (trial.stage !== 'fate' || !trial.defendant) return;
    const defendant = this.world.villagers.get(trial.defendant);
    if (!defendant?.alive || (pick !== 'kill' && pick !== 'spare')) return;
    const delta = pick === 'spare' ? 2 : -2;
    const note = pick === 'spare' ? `裁判投票で${defendant.name}への同情が増えた` : `裁判投票で${defendant.name}への敵意が増えた`;
    for (const observer of this.trialStatementSpeakers(trial)) {
      this.adjustRelationship(observer, defendant, delta, note);
      this.adjustRelationship(defendant, observer, Math.trunc(delta / 2), note);
    }
  }

  repairTrialState(reason = 'unknown'): TrialRepairResult {
    const messages: string[] = [];
    const w = this.world;

    if (w.phase === 'sho' && !w.incident) {
      w.phase = 'kisho';
      messages.push(`承の事件が欠落していたため起へ戻しました (${reason})`);
    }

    if (w.phase === 'ten' && !w.incident) {
      w.trial = null;
      w.phase = 'kisho';
      messages.push(`裁判の事件データが欠落していたため裁判を閉じました (${reason})`);
      return { repaired: messages.length > 0, messages };
    }

    if (w.phase === 'ten' && w.incident && !w.trial) {
      if (this.trialOpenedToday()) {
        w.incident = null;
        w.phase = 'kisho';
        messages.push('同日二度目の裁判を避けるため、欠落裁判を閉じました');
      } else {
        w.trial = this.openTrial(w.incident);
        messages.push('裁判データが欠落していたため、事件から裁判を再生成しました');
      }
    }

    const trial = w.trial;
    if (!trial) return { repaired: messages.length > 0, messages };

    if ((w.phase === 'ketsu' || w.phase === 'reform') && !w.incident) {
      w.trial = null;
      w.phase = 'kisho';
      messages.push('判決後の事件データが欠落していたため、通常進行へ戻しました');
      return { repaired: true, messages };
    }

    const aliveIds = new Set(aliveVillagers(w).map((v) => v.id));
    const beforeCandidates = trial.candidates.length;
    trial.candidates = trial.candidates.filter((id) => aliveIds.has(id));
    if (trial.candidates.length !== beforeCandidates) messages.push('裁判候補から不在の住民を除外しました');

    const seedIds: VillagerId[] = [];
    if (w.incident) {
      seedIds.push(w.incident.perpetrator, ...w.incident.involved);
      if (w.incident.framedTargetId) seedIds.push(w.incident.framedTargetId);
    }
    for (const id of seedIds) {
      if (aliveIds.has(id) && !trial.candidates.includes(id)) {
        trial.candidates.push(id);
        messages.push(`裁判候補を補完しました: ${this.world.villagers.get(id)?.name ?? id}`);
      }
    }
    if (trial.candidates.length === 0) {
      const fallback = aliveVillagers(w)[0];
      if (fallback) {
        trial.candidates.push(fallback.id);
        messages.push(`裁判候補が空だったため補完しました: ${fallback.name}`);
      }
    }

    if (!Array.isArray(trial.pendingGroups)) {
      trial.pendingGroups = this.trialRoundGroups(trial.stage === 'fate' ? TRIAL_FATE_ROUNDS : TRIAL_FOOLISH_ROUNDS);
      messages.push('裁判の発言順を再生成しました');
    }

    if (trial.stage === 'foolish') {
      if (trial.pendingGroups.length === 0 || trial.candidates.length === 1) {
        if (w.incident) this.finishFoolishStage(trial, w.incident);
        else trial.stage = 'fate';
        messages.push(`被告選択段階を修復しました: ${trial.defendant ?? '未定'}`);
      }
    } else if (trial.stage === 'fate') {
      if (!trial.defendant || !trial.candidates.includes(trial.defendant)) {
        trial.defendant = this.argmaxCandidate(trial);
        messages.push(`被告を補完しました: ${trial.defendant}`);
      }
      if (trial.pendingGroups.length === 0 && trial.verdict === null) {
        this.finishFateStage(trial);
        messages.push(`運命段階を判決まで補完しました: ${trial.verdict}`);
      }
    } else if (trial.stage === 'decided') {
      if (trial.verdict === null) {
        trial.verdict = trial.fateVotes.kill > trial.fateVotes.spare ? 'death' : 'spared';
        messages.push(`欠落した判決を補完しました: ${trial.verdict}`);
      }
      if (w.phase !== 'ketsu' && w.phase !== 'reform') {
        w.phase = 'ketsu';
        messages.push('判決済み裁判の phase を ketsu に戻しました');
      }
    }

    if (w.phase === 'ketsu' && trial.verdict === null) {
      if (!trial.defendant) trial.defendant = this.argmaxCandidate(trial);
      this.finishFateStage(trial);
      messages.push(`判決 phase の欠落を補完しました: ${trial.verdict}`);
    }

    return { repaired: messages.length > 0, messages };
  }

  resolveTrialAfterPlayerStatement(pick: 'kill' | 'spare'): PlayerStatementResolution | null {
    const trial = this.world.trial;
    if (this.world.phase !== 'ten' || !trial || trial.stage !== 'fate' || !trial.defendant || trial.verdict !== null) return null;

    const speakers = this.trialStatementSpeakers(trial);
    const reactions = speakers.map((v) => {
      const supports = this.supportsPlayerStatement(v, pick);
      if (supports) {
        if (pick === 'kill') trial.fateVotes.kill += 1;
        else trial.fateVotes.spare += 1;
      } else if (pick === 'kill') {
        trial.fateVotes.spare += 1;
      } else {
        trial.fateVotes.kill += 1;
      }
      return {
        villagerId: v.id,
        name: v.name,
        supports,
        line: this.reactionLine(v, pick, supports),
      };
    });
    trial.pendingGroups = [];
    this.finishFateStage(trial);
    return { reactions, verdict: trial.verdict ?? 'spared' };
  }

  private trialStatementSpeakers(trial: TrialState): Villager[] {
    const incident = this.world.incident;
    const related = incident ? this.incidentRelatedIds(incident) : new Set<VillagerId>();
    return aliveVillagers(this.world)
      .filter((v) => v.id !== trial.defendant)
      .map((v) => ({
        v,
        score:
          (related.has(v.id) ? 100 : 0) +
          Math.min(24, v.stress * 2) +
          v.persona.traits.sociability * 12 +
          v.persona.traits.curiosity * 8 +
          v.persona.traits.discipline * 4,
      }))
      .sort((a, b) => b.score - a.score || a.v.id.localeCompare(b.v.id))
      .slice(0, 3)
      .map(({ v }) => v);
  }

  private supportsPlayerStatement(v: Villager, pick: 'kill' | 'spare'): boolean {
    if (this.world.residentControl === 'bt' && this.world.incident && this.world.trial?.defendant) {
      return fateTree({ axis: dominantAxis(v.persona.traits), voters: [v], defendant: this.get(this.world.trial.defendant), incident: this.world.incident }) === pick;
    }
    const t = v.persona.traits;
    if (pick === 'kill') {
      const score = t.aggression * 0.38 + t.discipline * 0.22 + t.ambition * 0.18 + this.world.reputation.malice * 0.22 - t.kindness * 0.28;
      return score >= 0.34;
    }
    const score = t.kindness * 0.4 + t.sociability * 0.2 + t.curiosity * 0.12 + this.world.reputation.benevolence * 0.2 - t.aggression * 0.24;
    return score >= 0.34;
  }

  private reactionLine(v: Villager, pick: 'kill' | 'spare', supports: boolean): string {
    if (this.world.residentControl === 'bt') return residentSpeech(v, this.world, supports ? pick : pick === 'kill' ? 'spare' : 'kill');
    const axis = dominantAxis(v.persona.traits);
    const label = PERSONALITY_LABELS[axis] ?? axis;
    if (pick === 'kill') {
      if (supports) return `${label}の目で見ても、もう庇えないと思う`;
      return `${label}としては、まだ決めつけるには早い`;
    }
    if (supports) return `${label}の私には、教育で戻せる余地が見える`;
    return `${label}の立場では、甘すぎる裁きに見える`;
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

  private hasStageVote(trial: TrialState, voter: 'madman' | 'culprit', stage: 'foolish' | 'fate'): boolean {
    return trial.votes.some((v) => {
      if (v.voter !== voter) return false;
      return stage === 'foolish'
        ? trial.candidates.includes(v.pick)
        : v.pick === 'kill' || v.pick === 'spare';
    });
  }

  private finishFoolishStage(trial: TrialState, incident: Incident): RevealResult | null {
    if (!trial.defendant) {
      // 狂人の扇動: 全グループ投票後、最も善良な候補へ重い票を投げて陥れる。
      const madman = this.aliveMadman();
      if (madman && !this.hasStageVote(trial, 'madman', 'foolish') && (this.world.residentControl !== 'bt' || manipulationTree(madman, this.world.term))) {
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
      if (framed && trial.candidates.includes(framed) && !this.hasStageVote(trial, 'culprit', 'foolish') && (this.world.residentControl !== 'bt' || manipulationTree(this.get(incident.perpetrator), this.world.term))) {
        const w = Math.round(3 + this.world.reputation.malice * 4);
        trial.foolishVotes[framed] = (trial.foolishVotes[framed] ?? 0) + w;
        trial.votes.push({ voter: 'culprit', weight: w, pick: framed });
      }
      trial.defendant = this.argmaxCandidate(trial);
    }
    trial.stage = 'fate';
    trial.pendingGroups = this.trialRoundGroups(TRIAL_FATE_ROUNDS);
    return maybeReveal(this.world, incident, trial, this.rng, this.trialComposeConfig);
  }

  private finishFateStage(trial: TrialState): void {
    if (trial.verdict === null) {
      // 狂人の扇動: 処刑へ重い票を上乗せする。
      const madman = this.aliveMadman();
      if (madman && !this.hasStageVote(trial, 'madman', 'fate') && (this.world.residentControl !== 'bt' || manipulationTree(madman, this.world.term))) {
        const w = this.madmanWeight();
        trial.fateVotes.kill += w;
        trial.votes.push({ voter: 'madman', weight: w, pick: 'kill' });
      }
      trial.verdict =
        this.moral === 'wholesome' ? 'spared' : trial.fateVotes.kill > trial.fateVotes.spare ? 'death' : 'spared';
    }
    trial.stage = 'decided';
    this.world.phase = 'ketsu';
  }

  private finishPendingTrialStage(trial: TrialState, incident: Incident): RevealResult | null {
    if (trial.stage === 'foolish') return this.finishFoolishStage(trial, incident);
    if (trial.stage === 'fate') {
      this.finishFateStage(trial);
      return null;
    }
    this.world.phase = 'ketsu';
    return null;
  }

  // --- 転: グループ bloc 投票 (1 グループ/ステップ) ---
  // 戻り値: 真犯人の発覚 (§v1.4-B reveal) が起きたらその内容 (server がログ)。
  async tenStep(): Promise<{ reveal: RevealResult | null }> {
    if (this.world.phase !== 'ten' || !this.world.trial || !this.world.incident) {
      throw new Error(`tenStep without active trial (phase ${this.world.phase})`);
    }
    const trial = this.world.trial;
    const incident = this.world.incident;
    let reveal: RevealResult | null = null;
    const axis = trial.pendingGroups[0];
    if (!axis) {
      return { reveal: this.finishPendingTrialStage(trial, incident) };
    }
    const voters = this.votersOf(axis);
    if (voters.length === 0) {
      trial.pendingGroups.shift();
      if (trial.pendingGroups.length === 0) reveal = this.finishPendingTrialStage(trial, incident);
      return { reveal };
    }

    if (trial.stage === 'foolish') {
      const candidates = trial.candidates.map((id) => this.get(id));
      const pick = await this.brain.groupVoteFoolish({ axis, voters, candidates, incident });
      trial.pendingGroups.shift();
      trial.foolishVotes[pick] = (trial.foolishVotes[pick] ?? 0) + voters.length;
      trial.votes.push({ voter: axis, weight: voters.length, pick });
      if (trial.pendingGroups.length === 0) {
        reveal = this.finishFoolishStage(trial, incident);
      }
    } else if (trial.stage === 'fate') {
      const defendant = this.get(trial.defendant as VillagerId);
      const vote = await this.brain.groupVoteFate({ axis, voters, defendant, incident });
      trial.pendingGroups.shift();
      if (vote === 'kill') trial.fateVotes.kill += voters.length;
      else trial.fateVotes.spare += voters.length;
      trial.votes.push({ voter: axis, weight: voters.length, pick: vote });
      if (trial.pendingGroups.length === 0) {
        this.finishFateStage(trial);
      }
    }
    return { reveal };
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
    // 判決は次の火種 (§v1.4-B) を残す: 冤罪/遺恨/更生/偽証。アーク由来の事件は火種を回収する。
    this.spawnVerdictThreads(trial, this.world.incident, defendant);
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

  /**
   * 判決が残す火種 (§v1.4-B)。ketsuStep から呼ぶ:
   * - 冤罪死 (framed のまま処刑 + 真犯人生存) → 遺恨 + 未解決
   * - 通常の死刑 → 配偶者がいれば遺恨、いなければ噂
   * - 教育 (spared) → 更生 (再犯か模範かの分岐持ち)
   * - 有罪証言つきで生き延びた → 偽証への遺恨
   * また、この事件がアーク由来 (scheduledIncident.arcThreadId) なら火種を回収する。
   */
  private spawnVerdictThreads(trial: TrialState, incident: Incident, defendant: Villager): void {
    const verdict = trial.verdict;
    const framedConviction =
      verdict === 'death' && incident.framedTargetId === defendant.id && (this.world.villagers.get(incident.perpetrator)?.alive ?? false);

    if (framedConviction) {
      const culprit = this.get(incident.perpetrator);
      this.addPlotThread({
        kind: 'grudge',
        actors: [{ id: defendant.id, name: defendant.name }],
        heat: 0.7,
        note: `${defendant.name}は冤罪で処刑された`,
      });
      this.addPlotThread({
        kind: 'unresolved',
        actors: [{ id: culprit.id, name: culprit.name }],
        heat: 0.6,
        note: `真犯人の${culprit.name}は野放しのまま村に居座る`,
      });
    } else if (verdict === 'death') {
      const partner = defendant.partnerId ? this.world.villagers.get(defendant.partnerId) : undefined;
      if (partner?.alive) {
        this.addPlotThread({
          kind: 'grudge',
          actors: [
            { id: partner.id, name: partner.name },
            { id: defendant.id, name: defendant.name },
          ],
          heat: 0.5,
          note: `${partner.name}は${defendant.name}の処刑を忘れない`,
        });
      } else {
        this.addPlotThread({
          kind: 'rumor',
          actors: [{ id: defendant.id, name: defendant.name }],
          heat: 0.3,
          note: `${defendant.name}の処刑の噂がささやかれる`,
        });
      }
    } else if (verdict === 'spared') {
      this.addPlotThread({
        kind: 'redemption',
        actors: [{ id: defendant.id, name: defendant.name }],
        heat: 0.5,
        note: `${defendant.name}は教育で作り替えられた — 再犯か、模範か`,
      });
      // 有罪証言 (§v1.4-A testify accuse) を受けて生き延びた → 偽証への遺恨。
      if (trial.testimonies?.some((t) => t.stance === 'accuse')) {
        this.addPlotThread({
          kind: 'grudge',
          actors: [{ id: defendant.id, name: defendant.name }],
          heat: 0.5,
          note: `${defendant.name}は法廷で偽証された恨みを抱えている`,
        });
      }
    }

    // アーク由来の事件 (§v1.4-B): 拾った火種は裁判の決着で回収される。
    const sched = this.world.scheduledIncident;
    if (incident.origin === 'designed' && sched?.arcThreadId) {
      resolveThread(this.world, sched.arcThreadId);
      delete sched.arcThreadId;
    }
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
    beginAftermath(this.world, summary?.text ?? '裁きが終わった。残された住民は、それぞれの日課へ戻る。');
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
    const beforeAppearance = { ...v.appearance, descriptors: [...v.appearance.descriptors] };
    const beforeTraits = { ...v.persona.traits };
    const changes: string[] = [];
    if (reform.persona?.traits) {
      for (const [k, nv] of Object.entries(reform.persona.traits)) {
        if (typeof nv !== 'number' || !Number.isFinite(nv) || !Object.hasOwn(v.persona.traits, k)) continue;
        const ax = k as PersonalityAxis;
        const ov = v.persona.traits[ax];
        const next = clamp01(ov + nv);
        const arrow = next > ov ? '↑' : next < ov ? '↓' : '→';
        v.persona.traits[ax] = next;
        changes.push(`${PERSONALITY_LABELS[ax] ?? ax}${arrow}`);
      }
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
    const mark = recordEducation(v, reform, this.world.term, beforeAppearance, beforeTraits);
    changes.push(`外見→${PART_LABELS[mark.part]}`);
    delete v.behaviorTrace;
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
          this.bindPair(a, b, 'spouse');
          out.marriages.push({ a: a.id, b: b.id, aName: a.name, bName: b.name });
        }
      }
    }

    if (alive.length < this.maxPopulation) {
      const pairs = this.birthPairs(alive);
      for (const [p1, p2] of pairs) {
        if (this.rng() >= this.birthChanceFor(p1, p2)) continue;
        const child = this.spawnChild(p1, p2);
        out.births.push({ childId: child.id, childName: child.name, parents: `${p1.name}と${p2.name}` });
        break;
      }
    }
    this.decayFamilyTime(alive);
    return out;
  }

  private birthPairs(alive: Villager[]): Array<[Villager, Villager]> {
    const pairs: Array<[Villager, Villager]> = [];
    for (const v of alive) {
      if (!v.partnerId || v.id >= v.partnerId) continue;
      const partner = this.world.villagers.get(v.partnerId);
      if (partner?.alive) pairs.push([v, partner]);
    }
    return pairs.sort((a, b) => `${a[0].id}:${a[1].id}`.localeCompare(`${b[0].id}:${b[1].id}`));
  }

  private birthChanceFor(p1: Villager, p2: Villager): number {
    const familyTime = (p1.eventParams[FAMILY_TIME] ?? 0) + (p2.eventParams[FAMILY_TIME] ?? 0);
    return Math.min(1, this.birthChance + Math.min(0.36, familyTime * 0.08));
  }

  private decayFamilyTime(villagers: Villager[]): void {
    for (const v of villagers) {
      const current = v.eventParams[FAMILY_TIME] ?? 0;
      if (current <= 0) continue;
      const next = current - 1;
      if (next <= 0) delete v.eventParams[FAMILY_TIME];
      else v.eventParams[FAMILY_TIME] = next;
    }
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
      name: generateUniqueVillagerName(this.world, this.rng),
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
    addResidentHistory(this.world, child, { origin: 'born', archetype: '子供' });
    connectNewVillager(this.world, child, this.rng);
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
    // 火種 (§v1.4-B) は日末に減衰し、冷え切ったものは消える。
    const burntThreads = decayThreads(this.world, this.plotConfig);
    // 村長選挙 (§17): 補欠/通常選挙・世論調査更新を日末に進める。
    const mayor = tickMayor(this.world, this.mayorConfig);
    return { monthRolled, burntThreads, holiday: holidayName(cal.year, cal.month, cal.dayOfMonth), mayor };
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
      villagers: this.llmFocusVillagers(8),
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
        name: generateUniqueVillagerName(this.world, this.rng),
        position,
        species,
        activity,
        traits,
        origin: 'born',
      });
      this.world.villagers.set(villager.id, villager);
      addResidentHistory(this.world, villager, { origin: 'born', archetype: '新入り' });
      connectNewVillager(this.world, villager, this.rng);
    }
  }
}
