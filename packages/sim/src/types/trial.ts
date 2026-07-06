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
  /** 投票主体: グループ=性格軸 / 'user' / 'madman'(狂人) / 'culprit'(擦り付け) / 'testimony'(§v1.4-A 証言) / 'witness'(§v1.4-B 目撃者)。 */
  voter: PersonalityAxis | 'user' | 'madman' | 'culprit' | 'testimony' | 'witness';
  /** bloc の重み (グループ人数 / ユーザは 1)。 */
  weight: number;
  /** foolish 段階は候補 VillagerId、fate 段階は 'kill'|'spare'。 */
  pick: string;
  /** ユーザ票のとき、どの接続ユーザの票か (重み合算 + 投票し直しの単位)。 */
  userId?: string;
}

/** 開廷時に立つ目撃者 (§v1.4-B witness)。foolish 票へ重みを乗せ、法廷で一言を言う。 */
export interface TrialWitness {
  id: VillagerId;
  name: string;
  /** 告発対象 (擦り付けがあれば framed = 冤罪に説得力)。 */
  accusedId: VillagerId;
  /** 証言の一言 (表示用)。 */
  line: string;
}

/** 真犯人の発覚 (§v1.4-B reveal)。冤罪被告が差し替わった逆転の記録。 */
export interface TrialReveal {
  fromId: VillagerId;
  fromName: string;
  toId: VillagerId;
  toName: string;
}

/** プレイヤーの証言 1 件 (§v1.4-A)。fate 段階の票へ 1 グループ分の重みを上乗せした記録。 */
export interface TestimonyRecord {
  userId: string;
  /** accuse=有罪 (死刑側) / defend=弁護 (教育側)。 */
  stance: 'accuse' | 'defend';
  /** 上乗せした重み (= 1 グループ分)。 */
  weight: number;
  /** 証言の一言 (任意、法廷の吹き出し用)。 */
  text?: string;
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
  /** プレイヤーの証言 (§v1.4-A)。1 ユーザ 1 裁判 1 回。無ければキー自体なし (旧 snapshot 互換)。 */
  testimonies?: TestimonyRecord[];
  /** 開廷時の目撃者 (§v1.4-B)。立たなかった裁判はキー自体なし。 */
  witnesses?: TrialWitness[];
  /** 真犯人の発覚 (§v1.4-B)。起きなければキー自体なし。 */
  reveal?: TrialReveal;
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
