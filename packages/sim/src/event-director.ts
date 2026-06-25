// 起のイベントを差配する。全どうぶつではなく、グループ代表に絞って (= 軽量化)
// イベント種別をクォータ (各最低2回/日) 付きで割り当てる。嫌がらせはピュアブリード優先。

import { EVENT_CATEGORIES, EVENT_MIN_PER_DAY, type EventCategory, type EventDirective } from './events.js';
import { groupByDominant } from './personality.js';
import type { World, Villager } from './types/index.js';
import { awakeVillagers } from './world.js';

export type Rng = () => number;

export interface DirectorOptions {
  rng?: Rng;
  /** 1 セグメントで動かす代表の最大数。 */
  maxRepsPerSegment?: number;
}

export class EventDirector {
  private counts: Record<EventCategory, number> = { harass: 0, good: 0, chat: 0 };
  private readonly rng: Rng;
  private readonly maxReps: number;

  constructor(opts: DirectorOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.maxReps = opts.maxRepsPerSegment ?? 3;
  }

  resetDay(): void {
    this.counts = { harass: 0, good: 0, chat: 0 };
  }

  get dayCounts(): Readonly<Record<EventCategory, number>> {
    return this.counts;
  }

  /** このセグメントのイベント群を計画する。グループ代表 × カテゴリ割当。 */
  planSegment(world: World, remainingSegments: number): EventDirective[] {
    const awake = awakeVillagers(world);
    if (awake.length === 0) return [];
    const groups = [...groupByDominant(awake, (v) => v.persona.traits).values()];
    const chosen = this.sample(groups, Math.min(this.maxReps, groups.length));
    const events: EventDirective[] = [];
    for (const group of chosen) {
      const category = this.nextCategory(remainingSegments);
      const actor = this.pickActor(group, category);
      const target = category === 'harass' ? this.pickTarget(awake, actor) : null;
      events.push({ category, actor: actor.id, target: target?.id ?? null });
    }
    return events;
  }

  /** クォータ未達があり、残りセグメントで埋めきるのにギリギリなら due を強制。 */
  private nextCategory(remainingSegments: number): EventCategory {
    const due = EVENT_CATEGORIES.filter((c) => this.counts[c] < EVENT_MIN_PER_DAY);
    const totalDue = due.reduce((s, c) => s + (EVENT_MIN_PER_DAY - this.counts[c]), 0);
    const pool = due.length > 0 && totalDue >= remainingSegments ? due : [...EVENT_CATEGORIES];
    const pick = pool[Math.floor(this.rng() * pool.length)] ?? 'chat';
    this.counts[pick] += 1;
    return pick;
  }

  private pickActor(group: Villager[], category: EventCategory): Villager {
    let pool = group;
    if (category === 'harass') {
      const pure = group.filter((v) => v.reformCount === 0);
      if (pure.length > 0) pool = pure; // ピュアブリード優先
    }
    return pool[Math.floor(this.rng() * pool.length)] ?? (group[0] as Villager);
  }

  private pickTarget(awake: Villager[], actor: Villager): Villager | null {
    const others = awake.filter((v) => v.id !== actor.id);
    if (others.length === 0) return null;
    return others[Math.floor(this.rng() * others.length)] ?? null;
  }

  private sample<T>(arr: T[], n: number): T[] {
    const copy = [...arr];
    const out: T[] = [];
    for (let i = 0; i < n && copy.length > 0; i += 1) {
      const idx = Math.floor(this.rng() * copy.length);
      out.push(copy.splice(idx, 1)[0] as T);
    }
    return out;
  }
}
