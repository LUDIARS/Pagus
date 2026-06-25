// Brain — sim と AI (LLM) の唯一の境界。
// sim は LLM/transport を知らず、この interface 越しにのみ AI 判断を要求する。
// server が claude -p で実装し、test は決定的 stub を注入する。

import type {
  Villager,
  GridPos,
  TimeOfDay,
  EmotionState,
  Incident,
  IncidentPerspective,
  TrialState,
  Reform,
} from './types/index.js';
import type { EventDirective } from './events.js';

/** sim がプログラムで算出して Brain へ渡す環境ビュー。 */
export interface EnvironmentView {
  position: GridPos;
  place: string;
  timeOfDay: TimeOfDay;
  nearby: Array<{ id: string; name: string; pos: GridPos }>;
}

// --- 起: 行動決定 ---

export interface ActionContext {
  villager: Villager;
  environment: EnvironmentView;
  /** EventDirector が差配したイベント (起の代表行動)。自由行動なら null。 */
  directive: EventDirective | null;
}

export interface ActionDecision {
  /** 移動先セル (留まるなら null)。 */
  move: GridPos | null;
  /** とった行動 (自然言語)。 */
  action: string;
  /** 更新後の感情。 */
  newEmotion: EmotionState;
  /** この行動が事件化するか。 */
  triggersIncident: boolean;
  /** 事件化する場合の種。 */
  incidentSeed: { description: string; involved: string[] } | null;
}

// --- 感情の初期化/更新 ---

export interface EmotionContext {
  villager: Villager;
  environment: EnvironmentView;
  /** 直近の出来事 (なければ空)。 */
  recentEvents: string[];
}

// --- 承: 事件 (GANs) 進行 ---

export interface IncidentContext {
  incident: Incident;
  /** 今回進行させる視点。 */
  perspective: IncidentPerspective;
  perpetrator: Villager;
  victims: Villager[];
}

export interface IncidentStep {
  /** その視点でとられた行動。 */
  action: string;
  /** 増加する被害量。 */
  damageDelta: number;
  /** 事件をここで終了させるか (閾値判定と別に AI が打ち切れる)。 */
  ended: boolean;
}

// --- 転: 裁判 1 ラウンド ---

export interface TrialContext {
  trial: TrialState;
  incident: Incident;
  perpetrator: Villager;
  victims: Villager[];
}

export interface TrialRound {
  winner: 'perpetrator' | 'victim';
  perpetratorClaim: string;
  victimClaim: string;
  judgement: string;
}

// --- 結: 教育内容決定 ---

export interface EducationContext {
  trial: TrialState;
  incident: Incident;
  perpetrator: Villager;
}

export interface Brain {
  updateEmotion(ctx: EmotionContext): Promise<EmotionState>;
  decideAction(ctx: ActionContext): Promise<ActionDecision>;
  advanceIncident(ctx: IncidentContext): Promise<IncidentStep>;
  judgeRound(ctx: TrialContext): Promise<TrialRound>;
  decideEducation(ctx: EducationContext): Promise<Reform>;
}
