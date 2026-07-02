// 世界側 LLM。Brain (個体の思考) とは別に、その日の裁判結果から村全体を評価する。
// 出力: 村の徳目評判 delta / 関与どうぶつの性格 delta / 新規出生数。

import type { Villager, VillagerId, Incident, Calendar, Verdict, VillageRule, IncidentDesign, PlotThread } from './types/index.js';
import type { VirtueVector } from './virtue.js';
import type { Personality } from './personality.js';
import type { BehaviorRule } from './behavior-rules.js';

export interface WorldEvalContext {
  reputation: VirtueVector;
  verdict: Verdict;
  defendant: Villager;
  incident: Incident;
  involved: Villager[];
  calendar: Calendar;
}

export interface DayEvaluation {
  /** 村の徳目評判の増減 (適用後 0..1 にクランプ)。 */
  reputationDelta: Partial<VirtueVector>;
  /** 関与どうぶつの性格の増減。 */
  villagerDeltas: Array<{ villager: VillagerId; personalityDelta: Partial<Personality> }>;
  /** 新規に増やすどうぶつの数 (村ベクトルに偏った個体)。 */
  spawn: number;
  /** その日の総評 (ログ表示用)。 */
  narrative: string;
}

/** 祝日にあたる日の文脈。世界側 LLM が祝祭の出来事を作る。 */
export interface HolidayContext {
  /** 祝日名 (例: 元日, 春分の日)。 */
  holiday: string;
  calendar: Calendar;
  reputation: VirtueVector;
  /** 祝祭に参加する生存どうぶつ (名前を彩りに使う)。 */
  villagers: Villager[];
}

/** 祝日イベントの結果。 */
export interface HolidayEvent {
  /** 祝日にまつわる出来事 (ログ/村の歴史に出す日本語)。 */
  narrative: string;
  /** 祝祭が村の評判に与える小さな変化 (適用後 0..1 にクランプ)。 */
  reputationDelta: Partial<VirtueVector>;
}

// --- 月次事件のスケジューリング / デザイン (§12.3) ---------------------------

/** 事件アーク (§v1.4-B) が火種から選んだテーマのヒント。 */
export interface ArcHint {
  /** 派生表が選んだテーマの種。LLM はこれを採用して肉付けする。 */
  themeSeed: string;
  /** 拾った火種の 1 行文脈。 */
  threadNote: string;
  /** 火種の関係者名。 */
  actorNames: string[];
}

/** 月初の発生日決定の文脈 (§12.3.1)。 */
export interface MonthlyScheduleContext {
  calendar: Calendar;
  reputation: VirtueVector;
  villagers: Villager[];
  villageRules: VillageRule[];
  /** 火種由来のテーマヒント (§v1.4-B)。無ければ自由テーマ。 */
  arcHint?: ArcHint;
}

/** 月初に決まる事件の発生日と大まかなテーマの種。 */
export interface MonthlySchedule {
  dayOfMonth: number;
  themeSeed: string;
}

/** 前日の詳細デザインの文脈 (§12.3.2)。 */
export interface IncidentDesignContext {
  calendar: Calendar;
  reputation: VirtueVector;
  villagers: Villager[];
  villageRules: VillageRule[];
  /** 月初に与えられたテーマの種。 */
  themeSeed: string;
  /** 居座る過去の事件用キャラ (連続犯の継続入力, §12.3.3)。 */
  survivingCulprits: Villager[];
  /** くすぶる火種 (§v1.4-B)。デザインの文脈に使う。 */
  plotThreads: PlotThread[];
}

// --- ふるまいの法則の起案 (RuleSmith, §2.1) ----------------------------------

/** ルール生成の文脈。村の評判・住民・既存ルール・暦を渡す。 */
export interface RuleProposalContext {
  reputation: VirtueVector;
  villagers: Villager[];
  existingRules: BehaviorRule[];
  calendar: Calendar;
}

export interface WorldBrain {
  evaluateDay(ctx: WorldEvalContext): Promise<DayEvaluation>;
  /** 祝日にあたる日のイベントを生成する (§4.7)。 */
  holidayEvent(ctx: HolidayContext): Promise<HolidayEvent>;
  /** 月初にその月の事件発生日を決める (§12.3.1)。 */
  scheduleMonthlyIncident(ctx: MonthlyScheduleContext): Promise<MonthlySchedule>;
  /** 事件前日に詳細デザイン + 事件用キャラ仕様を作る (§12.3.2)。 */
  designIncident(ctx: IncidentDesignContext): Promise<IncidentDesign>;
  /** ふるまいの法則を 1 つ起案する (RuleSmith, §2.1)。source='haiku'。 */
  proposeRule(ctx: RuleProposalContext): Promise<BehaviorRule>;
}
