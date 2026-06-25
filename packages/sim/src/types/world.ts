import type { Villager, VillagerId } from './villager.js';
import type { Incident } from './incident.js';
import type { TrialState } from './trial.js';

/** ターム内の進行フェーズ (起承転結 + 後処理)。 */
export type Phase =
  | 'idle'
  | 'kisho' // 起: 自律行動ループ
  | 'sho' // 承: 事件 (GANs)
  | 'ten' // 転: 裁判
  | 'ketsu' // 結: 教育
  | 'reform' // 住民改変の適用
  | 'advance'; // 時間進行

export type TimeOfDay = 'morning' | 'noon' | 'night';

export interface WorldConfig {
  gridWidth: number;
  gridHeight: number;
  /** 1 ターム長 (ms)。既定 10 分。 */
  termDurationMs: number;
  /** 起の行動 tick 間隔 (ms)。既定 10 秒。 */
  tickIntervalMs: number;
  /** 承の事件がこの被害量を超えたら収束 (転へ)。 */
  damageThreshold: number;
  /** 裁判の先取点数 (3 点先取)。 */
  trialWinningScore: number;
}

export interface World {
  config: WorldConfig;
  /** 現在のターム番号 (0 始まり)。 */
  term: number;
  timeOfDay: TimeOfDay;
  phase: Phase;
  villagers: Map<VillagerId, Villager>;
  /** 進行中の事件 (なければ null)。 */
  incident: Incident | null;
  /** 進行中の裁判 (なければ null)。 */
  trial: TrialState | null;
}
