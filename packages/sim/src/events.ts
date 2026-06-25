// 起のイベント種別。1 日あたり各種最低 2 回 + 残りランダム (生成器は v0.3)。

import type { PersonalityAxis } from './personality.js';

export const EVENT_CATEGORIES = ['harass', 'good', 'chat'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_LABELS: Record<EventCategory, string> = {
  harass: '住民への嫌がらせ',
  good: 'なんとなく世界的に良い行動',
  chat: '雑談',
};

/** イベント種別 → それを押し上げる性格軸。 */
export const EVENT_AXIS: Record<EventCategory, PersonalityAxis> = {
  harass: 'aggression',
  good: 'kindness',
  chat: 'sociability',
};

/** 1 日に各種で最低こなす回数。 */
export const EVENT_MIN_PER_DAY = 2;

/** EventDirector が決める「誰が何をするか」。Brain はこれを narration する。 */
export interface EventDirective {
  category: EventCategory;
  /** 実行者 (VillagerId)。 */
  actor: string;
  /** 嫌がらせの対象 (VillagerId)。無ければ null。 */
  target: string | null;
}
