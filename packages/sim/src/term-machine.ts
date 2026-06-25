// 起承転結ステートマシン。World と Brain を保持し、フェーズを 1 ステップずつ進める。
// 時間制御 (tick 間隔・ターム長) は server が所有し、本クラスは純粋な遷移ロジックを提供する。

import type { World, Villager, VillagerId, Incident, TrialState, Verdict, Reform } from './types/index.js';
import type { Brain } from './brain.js';
import { aliveVillagers, environmentView, clampPos } from './world.js';

export type IdGen = () => string;

function counterIdGen(prefix: string): IdGen {
  let n = 0;
  return () => `${prefix}_${(n += 1)}`;
}

export interface KishoTickResult {
  /** 各村人の行動概要。 */
  actions: Array<{ villager: VillagerId; action: string }>;
  /** この tick で事件が発火したか。 */
  incidentStarted: boolean;
}

export class TermMachine {
  private pendingReform: Reform | null = null;

  constructor(
    public readonly world: World,
    private readonly brain: Brain,
    private readonly newIncidentId: IdGen = counterIdGen('inc'),
  ) {}

  /** ターム開始。idle → 起。 */
  start(): void {
    this.world.phase = 'kisho';
  }

  private get(id: VillagerId): Villager {
    const v = this.world.villagers.get(id);
    if (!v) throw new Error(`villager not found: ${id}`);
    return v;
  }

  // --- 起: 自律行動 1 tick ---
  async kishoTick(): Promise<KishoTickResult> {
    if (this.world.phase !== 'kisho') throw new Error(`kishoTick in phase ${this.world.phase}`);
    const actions: KishoTickResult['actions'] = [];
    for (const villager of aliveVillagers(this.world)) {
      const decision = await this.brain.decideAction({
        villager,
        environment: environmentView(this.world, villager),
      });
      if (decision.move) villager.position = clampPos(this.world, decision.move);
      villager.emotion = decision.newEmotion;
      actions.push({ villager: villager.id, action: decision.action });

      if (decision.triggersIncident && decision.incidentSeed && !this.world.incident) {
        this.world.incident = this.startIncident(villager.id, decision.incidentSeed);
        this.world.phase = 'sho';
        return { actions, incidentStarted: true };
      }
    }
    return { actions, incidentStarted: false };
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
      // 無罪は平和に終了。改変なし。
      this.pendingReform = null;
    } else {
      this.pendingReform = await this.brain.decideEducation({
        trial,
        incident: this.world.incident,
        perpetrator: this.get(this.world.incident.perpetrator),
      });
    }
    this.world.phase = 'reform';
  }

  /** 結の保留中の改変を適用。 */
  applyReform(): void {
    if (this.world.phase !== 'reform') throw new Error(`applyReform in phase ${this.world.phase}`);
    if (this.pendingReform) this.reform(this.pendingReform);
    this.pendingReform = null;
    this.world.incident = null;
    this.world.trial = null;
    this.world.phase = 'advance';
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

  /** 時間進行 (朝→昼→夜→翌タームの朝)。夜→朝の折返しでターム番号を進める。 */
  advanceTime(): void {
    if (this.world.phase !== 'advance') throw new Error(`advanceTime in phase ${this.world.phase}`);
    switch (this.world.timeOfDay) {
      case 'morning':
        this.world.timeOfDay = 'noon';
        break;
      case 'noon':
        this.world.timeOfDay = 'night';
        break;
      case 'night':
        this.world.timeOfDay = 'morning';
        this.world.term += 1;
        break;
    }
    this.world.phase = 'idle';
  }
}

export type { Verdict };
