import type { Villager, VillagerId, ActivityPattern, GridPos } from './villager.js';
import type { PlotThread } from './plot.js';
import type { Incident } from './incident.js';
import type { TrialState } from './trial.js';
import type { VirtueVector } from '../virtue.js';
import type { PersonalityAxis } from '../personality.js';
import type { BehaviorRule } from '../behavior-rules.js';

export type MartialMode = 'freeze' | 'surge';

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
  /** このスケジュールが拾った火種 id (§v1.4-B)。裁判決着で回収する。無ければ自由テーマ。 */
  arcThreadId?: string;
}

/** 村のしきたり (§12.8.1)。適当に用意され、事件の火種になる。 */
export interface VillageRule {
  id: string;
  /** しきたりの文 (例: 「夜に口笛を吹いてはならない」)。 */
  text: string;
}

/**
 * フィールドに落ちているアイテム (§16)。人手で配置するランダム配布物。
 * 貴金属 (precious) = 拾うと富む / 薬物 (drug) = 拾うと気が荒れ非行に走りやすい。
 * 'random' は配置時に precious/drug へ解決する。日末に最寄りの住民が拾って消える。
 */
export type FieldItemKind = 'precious' | 'drug';

export interface FieldItem {
  id: string;
  kind: FieldItemKind;
  position: GridPos;
}

/**
 * 村長選挙の匿名世論調査 (§17)。選挙の半年前 (campaign) から半月ごとに更新して表示する。
 * 支持率・人気候補・「わからない/みんなきらい/きょうみない」の村人世論を表す。
 */
export interface MayorPoll {
  /** 現村長の支持率 (0..1)。村長不在なら 0。 */
  approval: number;
  /** 人気候補 (人気度 support=0..1 降順、上位数体)。 */
  candidates: { id: VillagerId; name: string; support: number }[];
  /** 「わからない」の割合 (0..1)。 */
  dontKnow: number;
  /** 「みんなきらい」の割合 (0..1)。 */
  hate: number;
  /** 「きょうみない」の割合 (0..1)。 */
  noInterest: number;
}

/** 戒厳令の発動状態 (§v1.3-C ⑨)。freeze=月次事件を凍結 / surge=日常事件を多発させる。 */
export interface MartialState {
  mode: MartialMode;
  /** この term を超えたら失効 (日末に掃除)。term <= untilTerm の間だけ有効。 */
  untilTerm: number;
}

/** 場所の状態 (§v1.4-A' spot)。defiled=穢れ (荒れやすい) / blessed=清め (和む)。 */
export type SpotMode = 'defiled' | 'blessed';

/** 場所の状態 1 件 (§v1.4-A')。place は placeAt のラベル (広場/住宅地/村はずれ)。 */
export interface PlaceStateEntry {
  place: string;
  state: SpotMode;
  /** この term を超えたら失効 (日末に掃除)。term < untilTerm の間だけ有効。 */
  untilTerm: number;
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
  /** ふるまいの法則 (§2.1)。日常の感情/行動を決めるルール群。Haiku が日末に増やす。 */
  behaviorRules: BehaviorRule[];
  /** フィールドに落ちているアイテム (§16)。人手で配置し、日末に住民が拾う。 */
  items: FieldItem[];
  /** 場所の状態 (§v1.4-A' spot)。プレイヤーが場所を荒らす/清めると数日残り、日常行動に効く。 */
  placeStates: PlaceStateEntry[];
  /** 火種 (§v1.4-B PlotThread)。事件の結末が残す持ち越し状態。日末に減衰。 */
  plotThreads: PlotThread[];
  /** 現村長の villager id (§17)。選挙イベントで村人世論により決まる。空位は null。 */
  mayorId: VillagerId | null;
  /** 次の村長選挙までの残りターム数 (§17)。 */
  mayorTermsLeft: number;
  /** 選挙運動期間中の匿名世論調査 (§17)。期間外は null。 */
  mayorPoll: MayorPoll | null;
  /**
   * 戒厳令 (§v1.3-C ⑨)。発動中のみキーを持つ (exactOptionalPropertyTypes)。
   * freeze=fireScheduledIncident を抑止 / surge=DailyEngine の事件化閾値を下げる。
   */
  martial?: MartialState;
}
