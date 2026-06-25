// 起承転結ステートマシン。World と Brain を保持し、フェーズを 1 ステップずつ進める。
// 1 日 = 1 ターム = 12 セグメント。時間制御 (segmentRealMs のペース) は server が所有し、
// 本クラスは純粋な遷移ロジックを提供する。

import type { World, Villager, VillagerId, Incident, TrialState, Reform, Verdict, ActivityPattern } from './types/index.js';
import type { Brain, ActionDecision } from './brain.js';
import { aliveVillagers, awakeVillagers, environmentView, clampPos } from './world.js';
import { season, daysInMonth, holidayName } from './calendar.js';
import { groupByDominant, dominantAxis, PERSONALITY_AXES, type PersonalityAxis } from './personality.js';
import { personalityFromVirtue, VIRTUES } from './virtue.js';
import { createVillager } from './villager-factory.js';
import type { WorldBrain, DayEvaluation, WorldEvalContext } from './world-brain.js';
import type { EventDirector } from './event-director.js';

export type IdGen = () => string;

function counterIdGen(prefix: string): IdGen {
  let n = 0;
  return () => `${prefix}_${(n += 1)}`;
}

/** 0..1 に丸める。徳目評判・性格軸の適用後クランプに使う。 */
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** 出生どうぶつの種の候補。 */
const SPAWN_SPECIES = ['猫', '兎', '梟', '熊', '栗鼠'] as const;
/** 出生どうぶつの活動特性の候補。 */
const SPAWN_ACTIVITIES: readonly ActivityPattern[] = ['diurnal', 'nocturnal', 'crepuscular', 'always'];

export interface TermMachineOptions {
  /** 起のイベント差配 (省略時は全 awake どうぶつの自由行動)。 */
  director?: EventDirector;
  newIncidentId?: IdGen;
  /** 世界側 LLM。日末評価 (徳目評判・性格・出生) を司る。省略時は日末評価を行わない。 */
  worldBrain?: WorldBrain;
  /** 乱数源 (出生のばらつき用)。既定 Math.random。 */
  rng?: () => number;
  /** alive どうぶつの上限。出生はこの数未満の範囲でのみ起こる。既定 16。 */
  maxPopulation?: number;
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
  private readonly worldBrain: WorldBrain | null;
  private readonly rng: () => number;
  private readonly maxPopulation: number;
  /** 出生どうぶつの通し番号 (seed の v_* と衝突しない born_N を振る)。 */
  private bornCount = 0;
  /** その日の裁判結末。applyReform が incident/trial を null にする前に ketsuStep で捕捉する。 */
  private dayOutcome: { incident: Incident; verdict: Verdict; defendantId: VillagerId } | null = null;

  constructor(
    public readonly world: World,
    private readonly brain: Brain,
    opts: TermMachineOptions = {},
  ) {
    this.director = opts.director ?? null;
    this.newIncidentId = opts.newIncidentId ?? counterIdGen('inc');
    this.worldBrain = opts.worldBrain ?? null;
    this.rng = opts.rng ?? Math.random;
    this.maxPopulation = opts.maxPopulation ?? 16;
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

  private groupAxes(): PersonalityAxis[] {
    return [...groupByDominant(aliveVillagers(this.world), (v) => v.persona.traits).keys()];
  }

  private votersOf(axis: PersonalityAxis): Villager[] {
    return aliveVillagers(this.world).filter((v) => dominantAxis(v.persona.traits) === axis);
  }

  private openTrial(incident: Incident): TrialState {
    return {
      incidentId: incident.id,
      judge: { kind: 'nekomori' },
      candidates: [incident.perpetrator, ...incident.involved],
      stage: 'foolish',
      pendingGroups: this.groupAxes(),
      foolishVotes: {},
      defendant: null,
      fateVotes: { kill: 0, spare: 0 },
      votes: [],
      verdict: null,
    };
  }

  /** 外部 (接続ユーザの通知投票) の 1 票を現段階に加える。 */
  addUserVote(pick: string): void {
    const trial = this.world.trial;
    if (!trial || trial.stage === 'decided') return;
    trial.votes.push({ voter: 'user', weight: 1, pick });
    if (trial.stage === 'foolish') trial.foolishVotes[pick] = (trial.foolishVotes[pick] ?? 0) + 1;
    else if (pick === 'kill') trial.fateVotes.kill += 1;
    else if (pick === 'spare') trial.fateVotes.spare += 1;
  }

  // --- 転: グループ bloc 投票 (1 グループ/ステップ) ---
  async tenStep(): Promise<void> {
    if (this.world.phase !== 'ten' || !this.world.trial || !this.world.incident) {
      throw new Error(`tenStep without active trial (phase ${this.world.phase})`);
    }
    const trial = this.world.trial;
    const incident = this.world.incident;
    const axis = trial.pendingGroups.shift();
    if (!axis) return; // 念のため (グループ無し)
    const voters = this.votersOf(axis);

    if (trial.stage === 'foolish') {
      const candidates = trial.candidates.map((id) => this.get(id));
      const pick = await this.brain.groupVoteFoolish({ axis, voters, candidates, incident });
      trial.foolishVotes[pick] = (trial.foolishVotes[pick] ?? 0) + voters.length;
      trial.votes.push({ voter: axis, weight: voters.length, pick });
      if (trial.pendingGroups.length === 0) {
        trial.defendant = this.argmaxCandidate(trial);
        trial.stage = 'fate';
        trial.pendingGroups = this.groupAxes();
      }
    } else if (trial.stage === 'fate') {
      const defendant = this.get(trial.defendant as VillagerId);
      const vote = await this.brain.groupVoteFate({ axis, voters, defendant, incident });
      if (vote === 'kill') trial.fateVotes.kill += voters.length;
      else trial.fateVotes.spare += voters.length;
      trial.votes.push({ voter: axis, weight: voters.length, pick: vote });
      if (trial.pendingGroups.length === 0) {
        trial.verdict = trial.fateVotes.kill > trial.fateVotes.spare ? 'death' : 'spared';
        trial.stage = 'decided';
        this.world.phase = 'ketsu';
      }
    }
  }

  /** 最多得票の候補 (同票は candidates の並び順で先勝ち)。 */
  private argmaxCandidate(trial: TrialState): VillagerId {
    let best = trial.candidates[0] as VillagerId;
    let bestVotes = trial.foolishVotes[best] ?? 0;
    for (const id of trial.candidates) {
      const v = trial.foolishVotes[id] ?? 0;
      if (v > bestVotes) {
        best = id;
        bestVotes = v;
      }
    }
    return best;
  }

  // --- 結: 教育内容決定 ---
  async ketsuStep(): Promise<void> {
    if (this.world.phase !== 'ketsu' || !this.world.trial || !this.world.incident) {
      throw new Error(`ketsuStep without verdict (phase ${this.world.phase})`);
    }
    const trial = this.world.trial;
    const defendant = this.get(trial.defendant as VillagerId);
    // applyReform が後で incident/trial を null にするため、日末評価用にここで捕捉する。
    this.dayOutcome = {
      incident: this.world.incident,
      verdict: trial.verdict as Verdict,
      defendantId: trial.defendant as VillagerId,
    };
    if (trial.verdict === 'death') {
      // 殺す → 追放 (退場)。
      this.pendingReform = { kind: 'exile', villager: defendant.id, rationale: '村の投票により処刑された' };
    } else {
      // 活かす → 強制的に良い子へ教育。
      this.pendingReform = await this.brain.decideEducation({
        trial,
        incident: this.world.incident,
        perpetrator: defendant,
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

  // --- 日末: 世界側 LLM 評価 (徳目評判更新 + 個体性格更新 + 偏り出生) ---
  // phase は変えない (server が advance フェーズで advanceDay の前に呼ぶ)。
  async evaluateDay(): Promise<DayEvaluation | null> {
    if (!this.worldBrain || !this.dayOutcome) return null;
    const outcome = this.dayOutcome;

    const defendant = this.world.villagers.get(outcome.defendantId);
    if (!defendant) {
      // 被告がワールドから消えている = 状態不整合。無言フォールバックせず捕捉を破棄する。
      this.dayOutcome = null;
      throw new Error(`evaluateDay: 被告が見つかりません: ${outcome.defendantId}`);
    }

    const involved: Villager[] = [];
    for (const id of outcome.incident.involved) {
      const v = this.world.villagers.get(id);
      if (v) involved.push(v);
    }

    const ctx: WorldEvalContext = {
      reputation: this.world.reputation,
      verdict: outcome.verdict,
      defendant,
      incident: outcome.incident,
      involved,
      calendar: this.world.calendar,
    };
    const evaluation = await this.worldBrain.evaluateDay(ctx);

    // 徳目評判 (村レーダー) を加算・クランプ。
    for (const virtue of VIRTUES) {
      const delta = evaluation.reputationDelta[virtue];
      if (delta !== undefined) {
        this.world.reputation[virtue] = clamp01(this.world.reputation[virtue] + delta);
      }
    }

    // 個体性格 (気質6軸) を加算・クランプ (存在する個体のみ)。
    for (const vd of evaluation.villagerDeltas) {
      const villager = this.world.villagers.get(vd.villager);
      if (!villager) continue;
      for (const axis of PERSONALITY_AXES) {
        const delta = vd.personalityDelta[axis];
        if (delta !== undefined) {
          villager.persona.traits[axis] = clamp01(villager.persona.traits[axis] + delta);
        }
      }
    }

    // 村ベクトルに偏った新個体を出生。
    if (evaluation.spawn > 0) this.spawnBiased(evaluation.spawn);

    this.dayOutcome = null;
    return evaluation;
  }

  /** 村の徳目評判を基準性格にした新個体を n 体出生する (maxPopulation 未満の範囲)。 */
  private spawnBiased(n: number): void {
    const base = personalityFromVirtue(this.world.reputation);
    for (let i = 0; i < n; i += 1) {
      if (aliveVillagers(this.world).length >= this.maxPopulation) break;
      const traits: Partial<Record<PersonalityAxis, number>> = {};
      for (const axis of PERSONALITY_AXES) {
        traits[axis] = clamp01(base[axis] + (this.rng() - 0.5) * 0.3);
      }
      this.bornCount += 1;
      const species = SPAWN_SPECIES[Math.floor(this.rng() * SPAWN_SPECIES.length)] ?? '猫';
      const activity = SPAWN_ACTIVITIES[Math.floor(this.rng() * SPAWN_ACTIVITIES.length)] ?? 'diurnal';
      const position = {
        x: Math.floor(this.rng() * this.world.config.gridWidth),
        y: Math.floor(this.rng() * this.world.config.gridHeight),
      };
      const villager = createVillager({
        id: `born_${this.bornCount}`,
        name: `新入り${this.bornCount}`,
        position,
        species,
        activity,
        traits,
      });
      this.world.villagers.set(villager.id, villager);
    }
  }
}
