import type { Villager, VillagerId, ActivityPattern } from './villager.js';
import type { Incident } from './incident.js';
import type { TrialState } from './trial.js';
import type { VirtueVector } from '../virtue.js';
import type { PersonalityAxis } from '../personality.js';

/** ターム内の進行フェーズ (起承転結 + 後処理)。 */
export type Phase =
  | 'idle'
  | 'kisho' // 起: 自律行動ループ (セグメント駆動)
  | 'sho' // 承: 事件 (GANs)
  | 'ten' // 転: 裁判
  | 'ketsu' // 結: 教育
  | 'reform' // 教育結果の適用
  | 'advance'; // 日末: 日/月の進行待ち

/** セグメント帯から導出する大まかな時間帯 (環境の言語化用)。 */
export type TimeOfDay = 'night' | 'morning' | 'noon' | 'evening';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** 実カレンダー連動の時計。月=実1日、日=1ターム、セグメント=日内の時間帯。 */
export interface Calendar {
  /** 西暦年 (閏判定・テーマ用)。 */
  year: number;
  /** 1..12 (実カレンダーの月に連動)。 */
  month: number;
  /** 1..daysInMonth。 */
  dayOfMonth: number;
  /** その月の日数 (実カレンダー由来。ターム実時間長の分母)。 */
  daysInMonth: number;
  /** 0..segmentsPerDay-1。 */
  segment: number;
  season: Season;
}

/**
 * 事件用キャラ (§12.3.3) の生成仕様。前日の詳細デザインで世界側 LLM が出す。
 * 通常の Villager スキーマに乗る形へ villager-factory が変換する (origin='incident')。
 */
export interface IncidentCharacterSpec {
  name: string;
  species: string;
  activity?: ActivityPattern;
  traits?: Partial<Record<PersonalityAxis, number>>;
  values?: string[];
  speechStyle?: string;
  body?: string;
  /** ログ用の役回り (例 '加害者'/'被害者'/'露出狂')。 */
  role: string;
  /** このキャラが加害者か。 */
  perpetrator: boolean;
}

/**
 * 事件の詳細デザイン (§12.3.2)。前日に世界側 LLM が確定する。
 * 新規キャラ生成・既存住民の巻き込み・連続犯 (scapegoat) の擦り付け対象を含む。
 */
export interface IncidentDesign {
  /** 事件の筋書き (自然言語)。 */
  description: string;
  /** 新規生成する事件用キャラ (0..n)。 */
  newCharacters: IncidentCharacterSpec[];
  /** 巻き込む既存住民の id。 */
  involvedIds: VillagerId[];
  /** 既存住民が加害者ならその id / 新規キャラが加害者なら null。 */
  perpetratorId: VillagerId | null;
  /** 連続犯: 真犯人が罪を擦り付けて居座るか。 */
  scapegoat: boolean;
  /** 陥れる既存住民 id (scapegoat 時。無ければ null)。 */
  framedTargetId: VillagerId | null;
}

/**
 * その月の事件スケジュール (§12.3)。月初に発生日を決め (designed=false)、
 * 前日に世界側 LLM が詳細デザイン + 事件用キャラ生成して designed=true にする。
 */
export interface ScheduledIncident {
  /** 事件が起きる日 (1..daysInMonth)。 */
  dayOfMonth: number;
  /** 月初に LLM が与える大まかなテーマの種。前日の詳細デザインの入力。 */
  themeSeed: string;
  /** 前日の詳細デザインが済んだか。 */
  designed: boolean;
  /** 発生日に発火済みか。 */
  fired: boolean;
  /** designed=true 後に確定する詳細デザイン (未デザインなら null)。 */
  design: IncidentDesign | null;
}

/** 村のしきたり (§12.8.1)。適当に用意され、事件の火種になる。 */
export interface VillageRule {
  id: string;
  /** しきたりの文 (例: 「夜に口笛を吹いてはならない」)。 */
  text: string;
}

export interface WorldConfig {
  gridWidth: number;
  gridHeight: number;
  /** 1 日 (= 1 ターム) を割るセグメント数。既定 12。 */
  segmentsPerDay: number;
  /** 承の事件がこの被害量を超えたら収束 (転へ)。 */
  damageThreshold: number;
  /** 裁判の先取点数 (3 点先取)。 */
  trialWinningScore: number;
}

export interface World {
  config: WorldConfig;
  /** 経過した総ターム数 (= 総日数, 0 始まり)。情報取得タームの基準。 */
  term: number;
  calendar: Calendar;
  phase: Phase;
  /** 村の評判 (徳目6軸レーダー)。世界側 LLM の日末評価で動く。 */
  reputation: VirtueVector;
  villagers: Map<VillagerId, Villager>;
  /** 進行中の事件 (なければ null)。 */
  incident: Incident | null;
  /** 進行中の裁判 (なければ null)。 */
  trial: TrialState | null;
  /** その月の事件スケジュール (§12.3)。未設定なら null。 */
  scheduledIncident: ScheduledIncident | null;
  /** 村のしきたり (§12.8.1)。事件の火種。 */
  villageRules: VillageRule[];
}
