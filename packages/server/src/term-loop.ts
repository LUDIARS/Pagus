// TermMachine をフェーズに応じて 1 ステップずつ駆動するループ。
// 時間制御はここが所有する: 起のセグメントはカレンダー導出ペース、事件の局面は速めに刻む。

import type { TermMachine, Brain, World } from '@pagus/sim';
import { pacedSegmentMs, type PaceOptions } from './clock.js';

export interface LoopHandlers {
  onSnapshot(world: World): void;
  onLog(phase: World['phase'], text: string): void;
}

/**
 * TermLoop が要求する Brain。incite (扇動) のため forceNext を持つ。
 * StubBrain (固定ロジック) と LlmBrain (扇動フラグ) の両方が構造的に満たす。
 */
export type LoopBrain = Brain & { forceNext(): void };

export class TermLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly tm: TermMachine,
    private readonly brain: LoopBrain,
    private readonly pace: PaceOptions,
    private readonly incidentStepMs: number,
    private readonly h: LoopHandlers,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** プレイヤーの扇動: 次に起きている どうぶつ が必ず事件を起こす + 和解しにくくする。 */
  incite(): void {
    this.brain.forceNext();
    this.tm.nudgeIncite();
  }

  /** プレイヤーの沈静化: 進行中の事件の被害を和らげ + 和解しやすくする。 */
  calm(): void {
    const inc = this.tm.world.incident;
    if (inc) inc.damage = Math.max(0, inc.damage - 3);
    this.tm.nudgeCalm();
  }

  /** プレイヤーの裁判投票を加える。 */
  vote(pick: string): void {
    this.tm.addUserVote(pick);
  }

  private nextDelay(): number {
    const w = this.tm.world;
    if (w.phase === 'kisho' || w.phase === 'idle') {
      return pacedSegmentMs(w.calendar.daysInMonth, w.config.segmentsPerDay, this.pace);
    }
    return this.incidentStepMs;
  }

  private scheduleNext(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => console.error('[pagus] tick error', err))
        .finally(() => this.scheduleNext(this.nextDelay()));
    }, delay);
  }

  private async tick(): Promise<void> {
    const w = this.tm.world;
    const cal = w.calendar;
    switch (w.phase) {
      case 'idle':
        this.tm.startDay();
        this.h.onLog('kisho', `── ${cal.month}月${cal.dayOfMonth}日 (${cal.season}) はじまり ──`);
        break;
      case 'kisho': {
        const r = await this.tm.kishoTick();
        for (const a of r.actions) this.h.onLog('kisho', a.action);
        if (r.incidentStarted) {
          this.h.onLog('sho', `⚡ 事件: ${w.incident?.description ?? ''}`);
        } else {
          this.tm.advanceSegment();
        }
        break;
      }
      case 'sho': {
        const r = await this.tm.shoStep();
        if (r.secondaryVictim) this.h.onLog('sho', `⚠ 二次被害: ${r.secondaryVictim} も巻き込まれた`);
        if (r.outcome === 'reconciled') {
          this.h.onLog('kisho', '🕊 和解した — 事件は裁判にならず収まった');
        } else if (this.tm.world.phase === 'ten') {
          this.h.onLog('ten', '⚖ 審判人「猫守さん」登場');
        }
        break;
      }
      case 'ten':
        await this.tm.tenStep();
        if (this.tm.world.phase === 'ketsu') this.h.onLog('ketsu', `判決: ${w.trial?.verdict ?? ''}`);
        break;
      case 'ketsu':
        await this.tm.ketsuStep();
        break;
      case 'reform':
        this.tm.applyReform();
        this.h.onLog('kisho', '✦ 改変が適用された');
        break;
      case 'advance': {
        // 日末: 世界側 LLM が裁判結末を評価し、徳目評判・性格・出生を反映する。
        const ev = await this.tm.evaluateDay();
        if (ev) this.h.onLog('kisho', ev.narrative);
        const r = this.tm.advanceDay();
        const extra = `${r.monthRolled ? ' / 月がかわった' : ''}${r.holiday ? ` (${r.holiday})` : ''}`;
        this.h.onLog('kisho', `日が暮れた${extra}`);
        break;
      }
    }
    this.h.onSnapshot(w);
  }
}
