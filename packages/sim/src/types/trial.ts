import type { VillagerId } from './villager.js';
import type { Appearance, EmotionState } from './villager.js';
import type { Personality } from '../personality.js';

/** 審判人。基本は猫守さん (最強超人)。教育済み村人が務めることもある。 */
export type Judge = { kind: 'nekomori' } | { kind: 'villager'; id: VillagerId };

export type Verdict = 'death' | 'guilty' | 'innocent';

/** 転: 3 点先取の裁判状態。 */
export interface TrialState {
  incidentId: string;
  judge: Judge;
  /** 加害者側の得点。 */
  scorePerpetrator: number;
  /** 被害者側の得点。 */
  scoreVictim: number;
  rounds: TrialRoundRecord[];
  /** 確定した審判 (未確定なら null)。 */
  verdict: Verdict | null;
}

/** 裁判 1 ラウンドの結果 (どちらが 1 点取ったか)。 */
export interface TrialRoundRecord {
  /** この点を取った側。 */
  winner: 'perpetrator' | 'victim';
  /** 加害者視点の主張。 */
  perpetratorClaim: string;
  /** 被害者視点の主張。 */
  victimClaim: string;
  /** 審判人の判定理由。 */
  judgement: string;
}

/** 結: 教育 (改変) の指示。sim が村人へ適用する。 */
export type Reform =
  | { kind: 'exile'; villager: VillagerId; rationale: string }
  | {
      kind: 'educate';
      villager: VillagerId;
      rationale: string;
      /** 適用する人格の差分 (性格軸は部分指定可)。 */
      persona?: { traits?: Partial<Personality>; values?: string[]; speechStyle?: string };
      appearance?: Partial<Appearance>;
      emotion?: Partial<EmotionState>;
    };
