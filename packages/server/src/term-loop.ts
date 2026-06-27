// TermMachine をフェーズに応じて 1 ステップずつ駆動するループ。
// 時間制御はここが所有する: 起のセグメントはカレンダー導出ペース、事件の局面は速めに刻む。

import type { TermMachine, World } from '@pagus/sim';
import { pacedSegmentMs, type PaceOptions } from './clock.js';

export interface LoopHandlers {
  onSnapshot(world: World): void;
  onLog(phase: World['phase'], text: string): void;
  /** 裁判が開いた (承→転) ときに 1 度だけ呼ぶ。糾弾セリフ生成のフック。 */
  onTrialOpen?(world: World): void;
}

export class TermLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly tm: TermMachine,
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

  /** プレイヤーの扇動 (§4.2): 対象に偽情報を吹き込み事件化を促す。生存しなければ false。 */
  inciteTarget(targetId: string, rumorAboutId?: string): boolean {
    return this.tm.inciteTarget(targetId, rumorAboutId);
  }

  /** プレイヤーの応援 (§4.5): 対象の気質を後押しする。応援した軸/名前、生存しなければ null。 */
  cheer(targetId: string): { axis: string; villagerName: string } | null {
    return this.tm.cheer(targetId);
  }

  /**
   * プレイヤーの制裁 (§4.3): 対象を即時つるし上げ裁判にかける。成功すれば true。
   * 裁判が開く (phase=ten) ので糾弾セリフ生成のため onTrialOpen を呼ぶ。
   */
  sanction(targetId: string): boolean {
    const ok = this.tm.sanction(targetId);
    if (ok && this.tm.world.phase === 'ten') this.h.onTrialOpen?.(this.tm.world);
    return ok;
  }

  /** プレイヤーの裁判投票を加える (userId ごとに 1 席、重み合算)。 */
  vote(pick: string, userId?: string): void {
    this.tm.addUserVote(pick, userId);
  }

  /** 事件前日の詳細デザイン + 事件用キャラ生成を実行し、予兆をログに出す (§12.3.2)。 */
  private async designScheduled(): Promise<void> {
    const result = await this.tm.designScheduledIncident();
    if (!result) return;
    const names = result.spawned.map((s) => s.name).join('・') || '(新規キャラなし)';
    this.h.onLog('kisho', `⚡(予兆) ${names} が現れた — ${result.design.description}`);
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
        // 月次事件 (§12.3) は組織的 kishoTick より先に発火させる。発火したら承へ。
        if (this.tm.fireScheduledIncident()) {
          this.h.onLog('sho', `⚡ 事件: ${w.incident?.description ?? ''}`);
          this.h.onSnapshot(w);
          return;
        }
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
          this.h.onLog('ten', '—— 審判の時 ——');
          this.h.onTrialOpen?.(this.tm.world);
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
      case 'reform': {
        // どのように「いじられた」かをログに出す。
        const summary = this.tm.applyReform();
        this.h.onLog('kisho', summary ? `✦ ${summary.text}` : '✦ 改変が適用された');
        break;
      }
      case 'advance': {
        // 日末: 世界側 LLM が裁判結末を評価し、徳目評判・性格・出生を反映する。
        const ev = await this.tm.evaluateDay();
        if (ev) this.h.onLog('kisho', ev.narrative);
        const r = this.tm.advanceDay();
        const extra = `${r.monthRolled ? ' / 月がかわった' : ''}${r.holiday ? ` (${r.holiday})` : ''}`;
        this.h.onLog('kisho', `日が暮れた${extra}`);
        // 月初: その月の事件発生日を決める (§12.3.1)。発生日が初日なら前日が無いので即デザイン。
        if (r.monthRolled) {
          const m = await this.tm.scheduleMonthlyIncident();
          if (m) {
            this.h.onLog('kisho', `📅 今月の事件予定: ${m.dayOfMonth}日`);
            if (m.dayOfMonth <= 1) await this.designScheduled();
          }
        }
        // 事件前日: 詳細デザイン + 事件用キャラ生成 (§12.3.2)。
        const sched = this.tm.world.scheduledIncident;
        if (sched && !sched.designed && this.tm.world.calendar.dayOfMonth === sched.dayOfMonth - 1) {
          await this.designScheduled();
        }
        // 祝日にあたる日は (AI) が祝祭イベントを発火する (§4.7)。
        if (r.holiday) {
          const hev = await this.tm.fireHolidayEvent(r.holiday);
          if (hev) this.h.onLog('kisho', `📅 ${r.holiday}: ${hev.narrative}`);
        }
        // 日末の生活イベント (結婚/出産)。
        const life = this.tm.lifeEvents();
        for (const m of life.marriages) this.h.onLog('kisho', `💍 ${m.aName} と ${m.bName} が結ばれた`);
        for (const b of life.births) this.h.onLog('kisho', `👶 ${b.parents} に ${b.childName} が生まれた`);
        break;
      }
    }
    this.h.onSnapshot(w);
  }
}
