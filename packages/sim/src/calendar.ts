// 実カレンダー連動の純関数群。壁時計は持たない (引数で受ける)。

import type { Season, TimeOfDay } from './types/world.js';
import type { ActivityPattern } from './types/villager.js';

export function season(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter'; // 12, 1, 2
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) throw new Error(`month out of range: ${month}`);
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS[month - 1] as number;
}

/** 日本の祝日 (固定日のみ; 春分/秋分は近似)。確定形は spec/data/holidays.md。 */
export function holidayName(month: number, day: number): string | null {
  const fixed: Record<string, string> = {
    '1-1': '元日',
    '2-11': '建国記念の日',
    '2-23': '天皇誕生日',
    '3-20': '春分の日(近似)',
    '4-29': '昭和の日',
    '5-3': '憲法記念日',
    '5-4': 'みどりの日',
    '5-5': 'こどもの日',
    '8-11': '山の日',
    '9-23': '秋分の日(近似)',
    '11-3': '文化の日',
    '11-23': '勤労感謝の日',
  };
  return fixed[`${month}-${day}`] ?? null;
}

/** セグメントを時間帯に写す。例 (segmentsPerDay=12): 0-1夜 2-5朝 6-9昼 10-11夕。 */
export function timeOfDayForSegment(segment: number, segmentsPerDay: number): TimeOfDay {
  const f = segment / segmentsPerDay;
  if (f < 1 / 6) return 'night';
  if (f < 1 / 2) return 'morning';
  if (f < 5 / 6) return 'noon';
  return 'evening';
}

/** どうぶつがそのセグメントで起きているか (活動特性で判定)。 */
export function isAwake(activity: ActivityPattern, segment: number, segmentsPerDay: number): boolean {
  if (activity === 'always') return true;
  const f = segment / segmentsPerDay;
  const isDay = f >= 1 / 6 && f < 5 / 6; // 朝〜昼
  switch (activity) {
    case 'diurnal':
      return isDay;
    case 'nocturnal':
      return !isDay;
    case 'crepuscular': {
      // 薄明: 夜明け (≈1/6) と 日暮れ (≈5/6) の境界帯のみ起きる。
      const dawn = Math.abs(f - 1 / 6) < 1 / 12;
      const dusk = Math.abs(f - 5 / 6) < 1 / 12;
      return dawn || dusk;
    }
  }
}
