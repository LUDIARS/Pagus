// 世界側 LLM。Brain (個体の思考) とは別に、その日の裁判結果から村全体を評価する。
// 出力: 村の徳目評判 delta / 関与どうぶつの性格 delta / 新規出生数。

import type { Villager, VillagerId, Incident, Calendar, Verdict } from './types/index.js';
import type { VirtueVector } from './virtue.js';
import type { Personality } from './personality.js';

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

export interface WorldBrain {
  evaluateDay(ctx: WorldEvalContext): Promise<DayEvaluation>;
}
