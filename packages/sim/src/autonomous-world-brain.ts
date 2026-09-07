import type { WorldBrain, WorldEvalContext, DayEvaluation, HolidayContext, HolidayEvent, MonthlyScheduleContext, MonthlySchedule, IncidentDesignContext, RuleProposalContext, DistillContext } from './world-brain.js';
import type { IncidentDesign } from './types/index.js';
import type { BehaviorRule } from './behavior-rules.js';

/** Calendar and aftermath rules for the BT version. No model dependency on the clock. */
export class AutonomousWorldBrain implements WorldBrain {
  async evaluateDay(ctx: WorldEvalContext): Promise<DayEvaluation> {
    return { reputationDelta: ctx.verdict === 'death' ? { order: .04, malice: .03 } : { benevolence: .04 }, villagerDeltas: [], spawn: 0,
      narrative: `${ctx.defendant.name}の裁きが終わり、住民はそれぞれの日課へ戻る。` };
  }
  async holidayEvent(ctx: HolidayContext): Promise<HolidayEvent> { return { narrative: `${ctx.holiday}。噴水広場に祝祭の飾りが掛かった。`, reputationDelta: { vitality: .03 } }; }
  async scheduleMonthlyIncident(ctx: MonthlyScheduleContext): Promise<MonthlySchedule> {
    return { dayOfMonth: Math.min(ctx.calendar.daysInMonth, 8 + ctx.calendar.month % 15), themeSeed: ctx.arcHint?.themeSeed ?? '商店の預かり品をめぐる食い違い' };
  }
  async designIncident(ctx: IncidentDesignContext): Promise<IncidentDesign> {
    const residents = ctx.villagers.filter(v => v.alive).sort((a,b) => a.id.localeCompare(b.id));
    const actor = residents[ctx.calendar.month % Math.max(1, residents.length)];
    if (!actor) throw new Error('Cannot design a resident incident without residents');
    return { description: `${ctx.themeSeed}。${actor.name}の記憶と商店の記録が食い違い、広場で確認することになった。`, newCharacters: [], involvedIds: residents.filter(v => v.id !== actor.id).slice(0, 3).map(v => v.id), perpetratorId: actor.id, scapegoat: false, framedTargetId: null };
  }
  async proposeRule(_ctx: RuleProposalContext): Promise<BehaviorRule> { throw new Error('Automatic rule generation is disabled in BT control; use an explicit intervention'); }
  async distillRule(_ctx: DistillContext): Promise<BehaviorRule> { throw new Error('Automatic LLM distillation is disabled in BT control'); }
}
