// 村人 (ペルソナエンジン) のドメイン型。
// 「環境=プログラム / 感情=AI / 情報=蓄積」の三分を型レベルで表す。

import type { Personality } from '../personality.js';

export type VillagerId = string;

export interface GridPos {
  x: number;
  y: number;
}

/** どうぶつの活動特性。睡眠帯を決める。 */
export type ActivityPattern = 'diurnal' | 'nocturnal' | 'crepuscular' | 'always';

/** 改変対象となる村人の全人格パラメータ。 */
export interface Persona {
  /** 気質6軸の性格ベクトル (0..1)。dominant 軸でグループ分けされる。 */
  traits: Personality;
  /** 信条・行動原理 (自然言語)。 */
  values: string[];
  /** 口調。 */
  speechStyle: string;
}

/** 感情状態。AI (Brain) が初期化・更新する。 */
export interface EmotionState {
  /** 感情軸 (例: joy, anger, fear)。値域 -1..1。 */
  axes: Record<string, number>;
  /** 現在の気分ラベル (AI が言語化)。 */
  label: string;
}

export type InfoSource = 'self' | 'observation' | 'player' | 'event';

/** 村人が蓄積する知識/記憶の 1 片。 */
export interface InfoItem {
  id: string;
  text: string;
  source: InfoSource;
  /** 取得したターム番号。 */
  termAcquired: number;
}

/** 姿かたち。改変で変わる (例: body 'human' → 'machine')。 */
export interface Appearance {
  body: string;
  descriptors: string[];
}

export interface Villager {
  id: VillagerId;
  name: string;
  /** false = 追放/死刑で退場。以後登場しない。 */
  alive: boolean;
  persona: Persona;
  emotion: EmotionState;
  information: InfoItem[];
  /** 環境 (プログラムが算出・管理)。 */
  position: GridPos;
  appearance: Appearance;
  /** どうぶつの種 (例: 猫, 梟, 兎)。 */
  species: string;
  /** 活動特性 → 睡眠帯を決める。 */
  activity: ActivityPattern;
  /** 改変された回数。 */
  reformCount: number;
  /** 狂人フラグ。村の評判に応じて裁判を扇動し、無実の者を陥れる。 */
  madman: boolean;
}
