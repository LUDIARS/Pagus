// 起承転結ステートマシン。World と Brain を保持し、フェーズを 1 ステップずつ進める。
// 1 日 = 1 ターム = 12 セグメント。時間制御 (segmentRealMs のペース) は server が所有し、
// 本クラスは純粋な遷移ロジックを提供する。

import type { World, Villager, VillagerId, Incident, TrialState, Reform, Verdict, ActivityPattern } from './types/index.js';
import type { Brain, ActionDecision } from './brain.js';
import { aliveVillagers, awakeVillagers, environmentView, clampPos } from './world.js';
import { season, daysInMonth, holidayName } from './calendar.js';
import { groupByDominant, dominantAxis, PERSONALITY_AXES, PERSONALITY_LABELS, type PersonalityAxis } from './personality.js';
import { personalityFromVirtue, VIRTUES } from './virtue.js';
import { createVillager } from './villager-factory.js';
import type { WorldBrain, DayEvaluation, WorldEvalContext, HolidayEvent } from './world-brain.js';
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
  /**
   * 事件が裁判に至らず「和解」する基礎確率 (0..1, 1 ステップごとに判定)。既定 0 (無効)。
   * 沈静化 (nudgeCalm) で上がり、扇動 (nudgeIncite) で下がる。
   */
  reconcileChance?: number;
  /** 事件中に第三者を巻き込む「二次被害」の確率 (0..1)。既定 0 (無効)。 */
  secondaryChance?: number;
  /** ストレス耐性の効き (被害者の平均 stress × これ = 受け流す確率)。既定 0 (無効)。 */
  stressFizzleK?: number;
  /** 日末に結婚イベントが起きる確率 (0..1)。既定 0。 */
  marriageChance?: number;
  /** 日末に夫婦から出産イベントが起きる確率 (0..1)。既定 0。 */
  birthChance?: number;
  /** スナップショット復元時の出生通し番号 (born_N が衝突しないよう引き継ぐ)。既定 0。 */
  bornCount?: number;
}

/** 日末の生活イベント (結婚/出産)。server がログ表示する。 */
export interface LifeEvents {
  marriages: Array<{ a: VillagerId; b: VillagerId; aName: string; bName: string }>;
  births: Array<{ childId: VillagerId; childName: string; parents: string }>;
}

/** 改変(いじられ方)の要約。server がログ表示する。 */
export interface ReformSummary {
  villager: VillagerId;
  name: string;
  text: string;
}

/** shoStep の結果。server がログ表示に使う。 */
export interface ShoResult {
  outcome: 'ongoing' | 'trial' | 'reconciled';
  /** 二次被害に巻き込まれた どうぶつ の名前 (無ければ null)。 */
  secondaryVictim: string | null;
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
  private readonly reconcileChance: number;
  private readonly secondaryChance: number;
  private readonly stressFizzleK: number;
  private readonly marriageChance: number;
  private readonly birthChance: number;
  /** 沈静化/扇動が動かす和解バイアス (事件ごとに 0 へリセット)。 */
  private reconcileBias = 0;
  /** 現ステージのユーザ票 (投票し直しで差し替えるため保持)。 */
  private userVote: { stage: TrialState['stage']; pick: string } | null = null;
  /** 出生どうぶつの通し番号 (seed の v_* と衝突しない born_N を振る)。 */
  private bornCount: number;
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
    this.reconcileChance = opts.reconcileChance ?? 0;
    this.secondaryChance = opts.secondaryChance ?? 0;
    this.stressFizzleK = opts.stressFizzleK ?? 0;
    this.marriageChance = opts.marriageChance ?? 0;
    this.birthChance = opts.birthChance ?? 0;
    this.bornCount = opts.bornCount ?? 0;
  }

  /** スナップショット保存用: 出生通し番号 (born_N が再起動後も衝突しないよう保持する)。 */
  getBornCount(): number {
    return this.bornCount;
  }

  /** プレイヤーの沈静化: この事件が和解しやすくなる。 */
  nudgeCalm(): void {
    this.reconcileBias = Math.min(0.5, this.reconcileBias + 0.12);
  }

  /** プレイヤーの扇動: この事件が和解しにくくなる (= 裁判に持ち込みやすい)。 */
  nudgeIncite(): void {
    this.reconcileBias = Math.max(-0.5, this.reconcileBias - 0.12);
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
      const seed = decision.incidentSeed;
      const victimIds = seed.involved.filter((id) => id !== actor.id);
      // ストレス耐性: 被害者が慣れっこなら、些細な嫌がらせは受け流して事件化しない。
      if (this.shrugsOff(victimIds)) {
        const v0 = victimIds[0] ? this.world.villagers.get(victimIds[0]) : undefined;
        actions.push({ villager: v0?.id ?? actor.id, action: `${v0?.name ?? '相手'}は慣れっこで受け流した` });
        return false;
      }
      this.world.incident = this.startIncident(actor.id, seed);
      this.world.phase = 'sho';
      return true;
    }
    return false;
  }

  /** 被害者の平均ストレス耐性で嫌がらせを受け流すか判定。 */
  private shrugsOff(victimIds: VillagerId[]): boolean {
    if (this.stressFizzleK <= 0 || victimIds.length === 0) return false;
    let sum = 0;
    let n = 0;
    for (const id of victimIds) {
      const v = this.world.villagers.get(id);
      if (v) {
        sum += v.stress;
        n += 1;
      }
    }
    if (n === 0) return false;
    const chance = Math.min(0.8, (sum / n) * this.stressFizzleK);
    return this.rng() < chance;
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
    this.reconcileBias = 0; // 事件ごとに和解バイアスをリセット。
    const involved = seed.involved.filter((id) => id !== perpetrator);
    // 事件をくぐった者はストレス耐性が上がる (次から些細な嫌がらせに動じにくい)。
    for (const id of [perpetrator, ...involved]) {
      const v = this.world.villagers.get(id);
      if (v) v.stress += 1;
    }
    return {
      id: this.newIncidentId(),
      perpetrator,
      involved,
      description: seed.description,
      damage: 0,
      steps: [],
      resolved: false,
    };
  }

  // --- 承: 事件 (GANs) 1 ステップ ---
  async shoStep(): Promise<ShoResult> {
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

    // 事件が一線を越えたら裁判へ (和解より優先)。
    if (step.ended || incident.damage >= this.world.config.damageThreshold) {
      incident.resolved = true;
      this.world.trial = this.openTrial(incident);
      this.world.phase = 'ten';
      return { outcome: 'trial', secondaryVictim: null };
    }

    // 二次被害: 一定確率で第三者を巻き込む。
    let secondaryVictim: string | null = null;
    if (this.rng() < this.secondaryChance) {
      const bystanders = aliveVillagers(this.world).filter(
        (v) => v.id !== incident.perpetrator && !incident.involved.includes(v.id),
      );
      const victim = bystanders[Math.floor(this.rng() * bystanders.length)];
      if (victim) {
        incident.involved.push(victim.id);
        incident.damage += 2;
        secondaryVictim = victim.name;
      }
    }

    // 和解: 沈静化で上がり扇動で下がる。被害が大きいほど和解しにくい。
    const damageRatio = incident.damage / this.world.config.damageThreshold;
    const chance = this.reconcileChance + this.reconcileBias - damageRatio * 0.1;
    if (incident.steps.length >= 1 && this.rng() < chance) {
      incident.resolved = true;
      this.world.incident = null;
      this.world.phase = 'kisho';
      return { outcome: 'reconciled', secondaryVictim };
    }

    return { outcome: 'ongoing', secondaryVictim };
  }

  private groupAxes(): PersonalityAxis[] {
    return [...groupByDominant(aliveVillagers(this.world), (v) => v.persona.traits).keys()];
  }

  private votersOf(axis: PersonalityAxis): Villager[] {
    return aliveVillagers(this.world).filter((v) => dominantAxis(v.persona.traits) === axis);
  }

  private openTrial(incident: Incident): TrialState {
    this.userVote = null;
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

  /**
   * 接続ユーザの通知投票 1 票を現段階に加える。
   * 同じ段階で投票し直したら前回票を取り消して差し替える。
   */
  addUserVote(pick: string): void {
    const trial = this.world.trial;
    if (!trial || trial.stage === 'decided') return;

    // 同段階の前回ユーザ票を取り消す (投票し直し)。
    if (this.userVote && this.userVote.stage === trial.stage) {
      const prev = this.userVote.pick;
      if (trial.stage === 'foolish') {
        trial.foolishVotes[prev] = Math.max(0, (trial.foolishVotes[prev] ?? 0) - 1);
      } else if (prev === 'kill') {
        trial.fateVotes.kill = Math.max(0, trial.fateVotes.kill - 1);
      } else if (prev === 'spare') {
        trial.fateVotes.spare = Math.max(0, trial.fateVotes.spare - 1);
      }
      const i = trial.votes.findIndex((v) => v.voter === 'user' && v.pick === prev);
      if (i >= 0) trial.votes.splice(i, 1);
    }

    trial.votes.push({ voter: 'user', weight: 1, pick });
    if (trial.stage === 'foolish') trial.foolishVotes[pick] = (trial.foolishVotes[pick] ?? 0) + 1;
    else if (pick === 'kill') trial.fateVotes.kill += 1;
    else if (pick === 'spare') trial.fateVotes.spare += 1;
    this.userVote = { stage: trial.stage, pick };
  }

  /** 生存している狂人 (いなければ null)。 */
  private aliveMadman(): Villager | null {
    for (const v of this.world.villagers.values()) if (v.alive && v.madman) return v;
    return null;
  }

  /** 狂人の扇動の重み。村の評判が悪辣・無秩序なほど強くなる。 */
  private madmanWeight(): number {
    const rep = this.world.reputation;
    return Math.round(1 + rep.malice * 5 + (1 - rep.order) * 2);
  }

  /** 候補のうち最も「善良で無害」な者 (優しさ高・攻撃性低) = 陥れる標的。 */
  private scapegoat(candidateIds: VillagerId[]): VillagerId | null {
    let best: VillagerId | null = null;
    let bestScore = -Infinity;
    for (const id of candidateIds) {
      const v = this.world.villagers.get(id);
      if (!v || v.madman) continue;
      const score = v.persona.traits.kindness - v.persona.traits.aggression;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
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
        // 狂人の扇動: 全グループ投票後、最も善良な候補へ重い票を投げて陥れる。
        const madman = this.aliveMadman();
        if (madman) {
          const target = this.scapegoat(trial.candidates);
          if (target) {
            const w = this.madmanWeight();
            trial.foolishVotes[target] = (trial.foolishVotes[target] ?? 0) + w;
            trial.votes.push({ voter: 'madman', weight: w, pick: target });
          }
        }
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
        // 狂人の扇動: 処刑へ重い票を上乗せする。
        const madman = this.aliveMadman();
        if (madman) {
          const w = this.madmanWeight();
          trial.fateVotes.kill += w;
          trial.votes.push({ voter: 'madman', weight: w, pick: 'kill' });
        }
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

  /** 結の保留中の改変を適用し、その日の残りセグメントへ復帰 (起)。改変内容を要約で返す。 */
  applyReform(): ReformSummary | null {
    if (this.world.phase !== 'reform') throw new Error(`applyReform in phase ${this.world.phase}`);
    let summary: ReformSummary | null = null;
    if (this.pendingReform) {
      const v = this.world.villagers.get(this.pendingReform.villager);
      const text = this.reform(this.pendingReform);
      summary = { villager: this.pendingReform.villager, name: v?.name ?? this.pendingReform.villager, text };
    }
    this.pendingReform = null;
    this.world.incident = null;
    this.world.trial = null;
    this.world.phase = 'kisho';
    return summary;
  }

  /** 改変を適用し「どういじられたか」の要約文を返す。 */
  private reform(reform: Reform): string {
    const v = this.get(reform.villager);
    if (reform.kind === 'exile') {
      v.alive = false;
      return `${v.name} は村を追放された (${reform.rationale})`;
    }
    const changes: string[] = [];
    if (reform.persona?.traits) {
      for (const [k, nv] of Object.entries(reform.persona.traits)) {
        if (typeof nv !== 'number') continue;
        const ax = k as PersonalityAxis;
        const ov = v.persona.traits[ax];
        const arrow = nv > ov ? '↑' : nv < ov ? '↓' : '→';
        changes.push(`${PERSONALITY_LABELS[ax] ?? ax}${arrow}`);
      }
      v.persona.traits = { ...v.persona.traits, ...reform.persona.traits };
    }
    if (reform.persona?.values) {
      v.persona.values = reform.persona.values;
      changes.push(`信条「${reform.persona.values.join('・') || 'なし'}」`);
    }
    if (reform.persona?.speechStyle) {
      v.persona.speechStyle = reform.persona.speechStyle;
      changes.push(`口調「${reform.persona.speechStyle}」`);
    }
    if (reform.appearance) {
      if (reform.appearance.body) {
        changes.push(`体→${reform.appearance.body}`);
        v.appearance.body = reform.appearance.body;
      }
      if (reform.appearance.descriptors) v.appearance.descriptors = reform.appearance.descriptors;
    }
    if (reform.emotion) v.emotion = { ...v.emotion, ...reform.emotion };
    v.reformCount += 1;
    return `${v.name} は教育で作り替えられた: ${changes.join(' / ') || '微調整'} (${reform.rationale})`;
  }

  /** 日末の生活イベント (結婚/出産)。確率は option 既定 0 (= テスト不変)。 */
  lifeEvents(): LifeEvents {
    const out: LifeEvents = { marriages: [], births: [] };
    const alive = aliveVillagers(this.world);

    if (this.rng() < this.marriageChance) {
      const singles = alive.filter((v) => v.partnerId === null && !v.madman);
      if (singles.length >= 2) {
        const a = singles[Math.floor(this.rng() * singles.length)];
        const rest = a ? singles.filter((x) => x.id !== a.id) : [];
        const b = rest[Math.floor(this.rng() * rest.length)];
        if (a && b) {
          a.partnerId = b.id;
          b.partnerId = a.id;
          out.marriages.push({ a: a.id, b: b.id, aName: a.name, bName: b.name });
        }
      }
    }

    if (this.rng() < this.birthChance && alive.length < this.maxPopulation) {
      const reps = alive.filter(
        (v) => v.partnerId !== null && (this.world.villagers.get(v.partnerId)?.alive ?? false) && v.id < v.partnerId,
      );
      const p1 = reps[Math.floor(this.rng() * reps.length)];
      const p2 = p1?.partnerId ? this.world.villagers.get(p1.partnerId) : undefined;
      if (p1 && p2) {
        const child = this.spawnChild(p1, p2);
        out.births.push({ childId: child.id, childName: child.name, parents: `${p1.name}と${p2.name}` });
      }
    }
    return out;
  }

  /** 夫婦から子を 1 体出生 (気質はブレンド)。 */
  private spawnChild(p1: Villager, p2: Villager): Villager {
    this.bornCount += 1;
    const traits: Partial<Record<PersonalityAxis, number>> = {};
    for (const ax of PERSONALITY_AXES) {
      traits[ax] = clamp01((p1.persona.traits[ax] + p2.persona.traits[ax]) / 2 + (this.rng() - 0.5) * 0.2);
    }
    const child = createVillager({
      id: `born_${this.bornCount}`,
      name: `${p1.name}の子${this.bornCount}`,
      position: {
        x: Math.floor(this.rng() * this.world.config.gridWidth),
        y: Math.floor(this.rng() * this.world.config.gridHeight),
      },
      species: this.rng() < 0.5 ? p1.species : p2.species,
      activity: this.rng() < 0.5 ? p1.activity : p2.activity,
      traits,
    });
    this.world.villagers.set(child.id, child);
    return child;
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
    return { monthRolled, holiday: holidayName(cal.year, cal.month, cal.dayOfMonth) };
  }

  /**
   * 祝日にあたる日のイベントを (AI) で発火する (§4.7)。worldBrain が無ければ null。
   * 祝祭は村の評判をわずかに動かす (適用後 0..1 クランプ)。phase は変えない。
   */
  async fireHolidayEvent(holiday: string): Promise<HolidayEvent | null> {
    if (!this.worldBrain) return null;
    const event = await this.worldBrain.holidayEvent({
      holiday,
      calendar: this.world.calendar,
      reputation: this.world.reputation,
      villagers: aliveVillagers(this.world),
    });
    for (const virtue of VIRTUES) {
      const delta = event.reputationDelta[virtue];
      if (delta !== undefined) {
        this.world.reputation[virtue] = clamp01(this.world.reputation[virtue] + delta);
      }
    }
    return event;
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
