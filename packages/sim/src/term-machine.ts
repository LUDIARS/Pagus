// 起承転結ステートマシン。World と Brain を保持し、フェーズを 1 ステップずつ進める。
// 1 日 = 1 ターム = 12 セグメント。時間制御 (segmentRealMs のペース) は server が所有し、
// 本クラスは純粋な遷移ロジックを提供する。

import type { World, Villager, VillagerId, Incident, TrialState, Reform } from './types/index.js';
import type { Brain, ActionDecision } from './brain.js';
import { awakeVillagers, environmentView, clampPos } from './world.js';
import { season, daysInMonth, holidayName } from './calendar.js';
import type { EventDirector } from './event-director.js';

export type IdGen = () => string;

function counterIdGen(prefix: string): IdGen {
  let n = 0;
  return () => `${prefix}_${(n += 1)}`;
}

export interface TermMachineOptions {
  /** 起のイベント差配 (省略時は全 awake どうぶつの自由行動)。 */
  director?: EventDirector;
  newIncidentId?: IdGen;
}

export interface KishoTickResult {
  /** 起きていて行動した どうぶつ の行動概要。 */
  actions: Array<{ villager: VillagerId; action: string }>;
  /** この tick で事件が発火したか。 */
  incidentStarted: boolean;
}

export interface AdvanceDayResult {
  /** 月が変わったか (= 実 1 日境界の「大きな転換」)。 */
  monthRolled: boolean;
  /** 新しい日が祝日ならその名前。 */
  holiday: string | null;
}

export class TermMachine {
  private pendingReform: Reform | null = null;
  private readonly director: EventDirector | null;
  private readonly newIncidentId: IdGen;

  constructor(
    public readonly world: World,
    private readonly brain: Brain,
    opts: TermMachineOptions = {},
  ) {
    this.director = opts.director ?? null;
    this.newIncidentId = opts.newIncidentId ?? counterIdGen('inc');
  }

  /** その日 (ターム) を開始する。idle → 起。 */
  startDay(): void {
    this.world.phase = 'kisho';
    this.director?.resetDay();
  }

  private get(id: VillagerId): Villager {
    const v = this.world.villagers.get(id);
    if (!v) throw new Error(`villager not found: ${id}`);
    return v;
  }

  // --- 起: 現セグメントの行動 (director があれば代表のみ、無ければ全 awake) ---
  async kishoTick(): Promise<KishoTickResult> {
    if (this.world.phase !== 'kisho') throw new Error(`kishoTick in phase ${this.world.phase}`);
    const actions: KishoTickResult['actions'] = [];

    if (this.director) {
      const remaining = this.world.config.segmentsPerDay - this.world.calendar.segment;
      for (const directive of this.director.planSegment(this.world, remaining)) {
        const actor = this.world.villagers.get(directive.actor);
        if (!actor || !actor.alive) continue;
        const decision = await this.brain.decideAction({
          villager: actor,
          environment: environmentView(this.world, actor),
          directive,
        });
        if (this.applyDecision(actor, decision, actions)) return { actions, incidentStarted: true };
      }
      return { actions, incidentStarted: false };
    }

    for (const villager of awakeVillagers(this.world)) {
      const decision = await this.brain.decideAction({
        villager,
        environment: environmentView(this.world, villager),
        directive: null,
      });
      if (this.applyDecision(villager, decision, actions)) return { actions, incidentStarted: true };
    }
    return { actions, incidentStarted: false };
  }

  /** 行動を適用。事件が発火したら true を返し phase を sho にする。 */
  private applyDecision(
    actor: Villager,
    decision: ActionDecision,
    actions: KishoTickResult['actions'],
  ): boolean {
    if (decision.move) actor.position = clampPos(this.world, decision.move);
    actor.emotion = decision.newEmotion;
    actions.push({ villager: actor.id, action: decision.action });
    if (decision.triggersIncident && decision.incidentSeed && !this.world.incident) {
      this.world.incident = this.startIncident(actor.id, decision.incidentSeed);
      this.world.phase = 'sho';
      return true;
    }
    return false;
  }

  /** 現セグメントを終え、次セグメントへ。日末 (segment 一巡) に達したら phase=advance。 */
  advanceSegment(): { dayEnded: boolean } {
    if (this.world.phase !== 'kisho') throw new Error(`advanceSegment in phase ${this.world.phase}`);
    const next = this.world.calendar.segment + 1;
    if (next >= this.world.config.segmentsPerDay) {
      this.world.phase = 'advance';
      return { dayEnded: true };
    }
    this.world.calendar.segment = next;
    return { dayEnded: false };
  }

  private startIncident(
    perpetrator: VillagerId,
    seed: { description: string; involved: string[] },
  ): Incident {
    return {
      id: this.newIncidentId(),
      perpetrator,
      involved: seed.involved.filter((id) => id !== perpetrator),
      description: seed.description,
      damage: 0,
      steps: [],
      resolved: false,
    };
  }

  // --- 承: 事件 (GANs) 1 ステップ ---
  async shoStep(): Promise<void> {
    if (this.world.phase !== 'sho' || !this.world.incident) {
      throw new Error(`shoStep without active incident (phase ${this.world.phase})`);
    }
    const incident = this.world.incident;
    // 加害者視点 → 被害者視点 を交互に。
    const perspective = incident.steps.length % 2 === 0 ? 'perpetrator' : 'victim';
    const victims = incident.involved.map((id) => this.get(id));
    const step = await this.brain.advanceIncident({
      incident,
      perspective,
      perpetrator: this.get(incident.perpetrator),
      victims,
    });
    incident.steps.push({ perspective, action: step.action, damageDelta: step.damageDelta });
    incident.damage += step.damageDelta;

    if (step.ended || incident.damage >= this.world.config.damageThreshold) {
      incident.resolved = true;
      this.world.trial = this.openTrial(incident);
      this.world.phase = 'ten';
    }
  }

  private openTrial(incident: Incident): TrialState {
    return {
      incidentId: incident.id,
      judge: { kind: 'nekomori' },
      scorePerpetrator: 0,
      scoreVictim: 0,
      rounds: [],
      verdict: null,
    };
  }

  // --- 転: 裁判 1 ラウンド (3 点先取) ---
  async tenStep(): Promise<void> {
    if (this.world.phase !== 'ten' || !this.world.trial || !this.world.incident) {
      throw new Error(`tenStep without active trial (phase ${this.world.phase})`);
    }
    const trial = this.world.trial;
    const incident = this.world.incident;
    const round = await this.brain.judgeRound({
      trial,
      incident,
      perpetrator: this.get(incident.perpetrator),
      victims: incident.involved.map((id) => this.get(id)),
    });
    trial.rounds.push(round);
    if (round.winner === 'perpetrator') trial.scorePerpetrator += 1;
    else trial.scoreVictim += 1;

    const win = this.world.config.trialWinningScore;
    if (trial.scorePerpetrator >= win) {
      trial.verdict = 'innocent';
      this.world.phase = 'ketsu';
    } else if (trial.scoreVictim >= win) {
      // 完封 (加害者 0 点) なら死刑、それ以外は有罪。
      trial.verdict = trial.scorePerpetrator === 0 ? 'death' : 'guilty';
      this.world.phase = 'ketsu';
    }
  }

  // --- 結: 教育内容決定 ---
  async ketsuStep(): Promise<void> {
    if (this.world.phase !== 'ketsu' || !this.world.trial || !this.world.incident) {
      throw new Error(`ketsuStep without verdict (phase ${this.world.phase})`);
    }
    const trial = this.world.trial;
    if (trial.verdict === 'innocent') {
      this.pendingReform = null; // 無罪は平和に終了。改変なし。
    } else {
      this.pendingReform = await this.brain.decideEducation({
        trial,
        incident: this.world.incident,
        perpetrator: this.get(this.world.incident.perpetrator),
      });
    }
    this.world.phase = 'reform';
  }

  /** 結の保留中の改変を適用し、その日の残りセグメントへ復帰 (起)。 */
  applyReform(): void {
    if (this.world.phase !== 'reform') throw new Error(`applyReform in phase ${this.world.phase}`);
    if (this.pendingReform) this.reform(this.pendingReform);
    this.pendingReform = null;
    this.world.incident = null;
    this.world.trial = null;
    this.world.phase = 'kisho';
  }

  private reform(reform: Reform): void {
    const v = this.get(reform.villager);
    if (reform.kind === 'exile') {
      v.alive = false;
      return;
    }
    if (reform.persona) {
      if (reform.persona.traits) v.persona.traits = { ...v.persona.traits, ...reform.persona.traits };
      if (reform.persona.values) v.persona.values = reform.persona.values;
      if (reform.persona.speechStyle) v.persona.speechStyle = reform.persona.speechStyle;
    }
    if (reform.appearance) {
      if (reform.appearance.body) v.appearance.body = reform.appearance.body;
      if (reform.appearance.descriptors) v.appearance.descriptors = reform.appearance.descriptors;
    }
    if (reform.emotion) v.emotion = { ...v.emotion, ...reform.emotion };
    v.reformCount += 1;
  }

  /** 日を進める。月の日数を超えたら月遷移 (= 実 1 日境界の大きな転換)。 */
  advanceDay(): AdvanceDayResult {
    if (this.world.phase !== 'advance') throw new Error(`advanceDay in phase ${this.world.phase}`);
    const cal = this.world.calendar;
    this.world.term += 1;
    cal.segment = 0;
    let monthRolled = false;
    cal.dayOfMonth += 1;
    if (cal.dayOfMonth > cal.daysInMonth) {
      monthRolled = true;
      cal.dayOfMonth = 1;
      cal.month += 1;
      if (cal.month > 12) {
        cal.month = 1;
        cal.year += 1;
      }
      cal.daysInMonth = daysInMonth(cal.year, cal.month);
      cal.season = season(cal.month);
    }
    this.world.phase = 'idle';
    return { monthRolled, holiday: holidayName(cal.month, cal.dayOfMonth) };
  }
}
