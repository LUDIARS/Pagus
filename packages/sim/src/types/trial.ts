import type { VillagerId } from './villager.js';
import type { Appearance, EmotionState } from './villager.js';
import type { Personality, PersonalityAxis } from '../personality.js';

/** 審判人。基本は猫守さん (最強超人)。教育済み村人が務めることもある。 */
export type Judge = { kind: 'nekomori' } | { kind: 'villager'; id: VillagerId };

/** 殺す / 活かす(→教育)。 */
export type Verdict = 'death' | 'spared';

/** 裁判の段階。①最も愚かな行動 → 被告選出 ②殺す/活かす → 判決。 */
export type TrialStage = 'foolish' | 'fate' | 'decided';

/** グループ bloc または ユーザの 1 票。 */
export interface VoteRecord {
  /** 投票主体: グループは性格軸、ユーザは 'user'、狂人の扇動は 'madman'。 */
  voter: PersonalityAxis | 'user' | 'madman';
  /** bloc の重み (グループ人数 / ユーザは 1)。 */
  weight: number;
  /** foolish 段階は候補 VillagerId、fate 段階は 'kill'|'spare'。 */
  pick: string;
  /** ユーザ票のとき、どの接続ユーザの票か (重み合算 + 投票し直しの単位)。 */
  userId?: string;
}

/** 転: 投票による裁判の状態。 */
export interface TrialState {
  incidentId: string;
  judge: Judge;
  /** 被告候補 (その日の愚かしい行動の実行者たち)。 */
  candidates: VillagerId[];
  stage: TrialStage;
  /** 現段階でまだ投票していないグループ。 */
  pendingGroups: PersonalityAxis[];
  /** 「最も愚か」投票の集計 (candidate → 重み合計)。 */
  foolishVotes: Record<string, number>;
  /** 確定した被告。 */
  defendant: VillagerId | null;
  /** 「殺す/活かす」投票の集計。 */
  fateVotes: { kill: number; spare: number };
  votes: VoteRecord[];
  /** 確定した審判 (未確定なら null)。 */
  verdict: Verdict | null;
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
