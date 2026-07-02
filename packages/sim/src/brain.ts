// Brain — sim と AI (LLM) の唯一の境界。
// sim は LLM/transport を知らず、この interface 越しにのみ AI 判断を要求する。
// server が claude -p で実装し、test は決定的 stub を注入する。

import type {
  Villager,
  VillagerId,
  GridPos,
  TimeOfDay,
  EmotionState,
  Incident,
  IncidentPerspective,
  TrialState,
  Reform,
} from './types/index.js';
import type { EventDirective } from './events.js';
import type { PersonalityAxis } from './personality.js';

/** sim がプログラムで算出して Brain へ渡す環境ビュー。 */
export interface EnvironmentView {
  position: GridPos;
  place: string;
  timeOfDay: TimeOfDay;
  nearby: Array<{ id: string; name: string; pos: GridPos }>;
  /** いる場所の状態 (§v1.4-A' spot)。荒らされ/清められた場所にいるときだけ値を持つ。 */
  placeState?: 'defiled' | 'blessed';
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

// --- 転: グループ bloc 投票 ---

/** ①「どの住民の行動が最も愚かしかったか」を 1 グループが投票。 */
export interface FoolishVoteContext {
  axis: PersonalityAxis;
  voters: Villager[];
  candidates: Villager[];
  incident: Incident;
}

/** ②「被告を殺す/活かす」を 1 グループが投票。 */
export interface FateVoteContext {
  axis: PersonalityAxis;
  voters: Villager[];
  defendant: Villager;
  incident: Incident;
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
  /** ① 最も愚かな候補へ 1 グループが投票。 */
  groupVoteFoolish(ctx: FoolishVoteContext): Promise<VillagerId>;
  /** ② 被告を殺す/活かす を 1 グループが投票。 */
  groupVoteFate(ctx: FateVoteContext): Promise<'kill' | 'spare'>;
  decideEducation(ctx: EducationContext): Promise<Reform>;
}
