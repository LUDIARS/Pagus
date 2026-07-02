// TermMachine をフェーズに応じて 1 ステップずつ駆動するループ。
// 時間制御はここが所有する: 起のセグメントはカレンダー導出ペース、事件の局面は速めに刻む。

import type { TermMachine, World, HeckleSide, HeckleResult, TestifyOutcome, GiftKind, GiftResult, SpotResult, FanFlamesResult } from '@pagus/sim';
import { pacedSegmentMs, type PaceOptions } from './clock.js';

export interface LoopHandlers {
  onSnapshot(world: World): void;
  onLog(phase: World['phase'], text: string): void;
  /** 裁判が開いた (承→転) ときに 1 度だけ呼ぶ。糾弾セリフ生成のフック。 */
  onTrialOpen?(world: World): void;
}

/** ふるまいの法則の Haiku 増殖設定 (§2.1)。 */
export interface RuleGenOptions {
  /** 有効か (PAGUS_RULEGEN)。既定で有効。 */
  enabled: boolean;
  /** 日末に増殖を試みる確率 (PAGUS_RULEGEN_CHANCE)。 */
  chance: number;
  /** 乱数源 (既定 Math.random)。 */
  rng?: () => number;
}

export class TermLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly ruleGen: RuleGenOptions;
  private readonly ruleRng: () => number;

  constructor(
    private readonly tm: TermMachine,
    private readonly pace: PaceOptions,
    private readonly incidentStepMs: number,
    private readonly h: LoopHandlers,
    ruleGen: RuleGenOptions = { enabled: false, chance: 0 },
  ) {
    this.ruleGen = ruleGen;
    this.ruleRng = ruleGen.rng ?? Math.random;
  }

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

  /** プレイヤーの野次 (§v1.4-A): 進行中の事件を煽る/なだめる。事件中でなければ null。 */
  heckle(side: HeckleSide): HeckleResult | null {
    return this.tm.heckle(side);
  }

  /** プレイヤーの証言 (§v1.4-A): 裁判の fate 段階へ 1 グループ分の票を上乗せする。 */
  testify(userId: string, stance: 'accuse' | 'defend', text?: string): TestifyOutcome {
    return this.tm.testify(userId, stance, text);
  }

  /** プレイヤーの贈り物 (§v1.4-A): 差し入れ/毒饅頭を対象へ即適用する。不在なら null。 */
  gift(targetId: string, kind: GiftKind): GiftResult | null {
    return this.tm.giveGift(targetId, kind);
  }

  /** プレイヤーの場所介入 (§v1.4-A'): 荒らす/清める。place 不正なら null。 */
  spot(place: string, mode: 'defile' | 'bless', days: number): SpotResult | null {
    return this.tm.spot(place, mode, days);
  }

  /** プレイヤーの噂の増幅 (§v1.4-A')。対象不在/噂なしなら null。 */
  fanFlames(targetId: string): FanFlamesResult | null {
    return this.tm.fanFlames(targetId);
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
        // フィールドアイテムの回収 (§v1.4-A 体感即時化): 最寄りが取りに歩き、届いたら拾う。
        for (const p of this.tm.tickItems()) {
          this.h.onLog('kisho', p.kind === 'precious' ? `💎 ${p.name} が貴金属を拾った` : `💊 ${p.name} が薬物に手を出した`);
        }
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
          // 目撃者 (§v1.4-B witness): 開廷時の証言をログに出す。
          for (const wit of this.tm.world.trial?.witnesses ?? []) {
            this.h.onLog('ten', `👁 目撃者 ${wit.name}「${wit.line}」`);
          }
          this.h.onTrialOpen?.(this.tm.world);
        }
        break;
      }
      case 'ten': {
        const r = await this.tm.tenStep();
        // 真犯人の発覚 (§v1.4-B reveal): 冤罪被告が差し替わる逆転をログに出す。
        if (r.reveal) {
          this.h.onLog('ten', `🔦 逆転: 真犯人は ${r.reveal.toName} だった！ ${r.reveal.fromName} は解放された`);
        }
        if (this.tm.world.phase === 'ketsu') this.h.onLog('ketsu', `判決: ${w.trial?.verdict ?? ''}`);
        break;
      }
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
        // 天災カード等の TTL 切れ一時ルールを除去する (§v1.3-A)。hidden 退避の復帰は advanceDay 内で済む。
        const expired = this.tm.pruneExpiredRules();
        for (const rule of expired) this.h.onLog('kisho', `🃏 天災がおさまった: 「${rule.description}」`);
        // 場所の状態 (§v1.4-A') の期限切れを掃除する。
        for (const spot of this.tm.pruneExpiredPlaceStates()) {
          this.h.onLog('kisho', spot.state === 'defiled' ? `💨 ${spot.place}の穢れが晴れた` : `💨 ${spot.place}の清めが薄れた`);
        }
        const extra = `${r.monthRolled ? ' / 月がかわった' : ''}${r.holiday ? ` (${r.holiday})` : ''}`;
        this.h.onLog('kisho', `日が暮れた${extra}`);
        // 村長選挙 (§17): 通常選挙/補欠選挙が起きたらログに出す。
        if (r.mayor) {
          this.h.onLog('kisho', r.mayor.kind === 'vacancy-elected'
            ? `🏛 村長が空位となり ${r.mayor.name} が選ばれた`
            : `🏛 村長選挙: ${r.mayor.name} が新しい村長に選ばれた`);
        }
        // 月初: その月の事件発生日を決める (§12.3.1)。発生日が初日なら前日が無いので即デザイン。
        if (r.monthRolled) {
          const m = await this.tm.scheduleMonthlyIncident();
          if (m) {
            this.h.onLog('kisho', `📅 今月の事件予定: ${m.dayOfMonth}日`);
            // 事件アーク (§v1.4-B): 火種由来のテーマが選ばれたら明示する。
            if (m.arcNote) this.h.onLog('kisho', `🧵 火種が芽吹く: ${m.arcNote} → 「${m.themeSeed}」`);
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
        // 日末の住民経済決済 (§15): 推し送金 / クズ化遷移 / プレイヤーへのたかり を live feed に出す。
        const econ = this.tm.settleEconomy();
        for (const t of econ.transfers) this.h.onLog('kisho', `💸 ${t.fromName} が推しの ${t.toName} に ${t.amount} を送った`);
        for (const s of econ.scumChanges) {
          this.h.onLog('kisho', s.scummy ? `🤑 ${s.name} は大金を持て余してクズ化した` : `🧹 ${s.name} は身を持ち直した`);
        }
        for (const d of econ.demands) this.h.onLog('kisho', `💢 ${d.name} がプレイヤーに ${d.amount} カルマをたかってきた`);
        // 日末: フィールドのアイテムを最寄りの住民が拾う (§16)。貴金属=富む / 薬物=荒れる。
        const pickups = this.tm.collectItems();
        for (const p of pickups) {
          this.h.onLog('kisho', p.kind === 'precious' ? `💎 ${p.name} が貴金属を拾った` : `💊 ${p.name} が薬物に手を出した`);
        }
        // ふるまいの法則の Haiku 増殖 (§2.1): 低確率で 1 つ生成して村に芽生えさせる。
        if (this.ruleGen.enabled && this.ruleRng() < this.ruleGen.chance) {
          const rule = await this.tm.maybeGrowRule();
          if (rule) this.h.onLog('kisho', `📜法則: 「${rule.description}」が村に芽生えた`);
        }
        break;
      }
    }
    this.h.onSnapshot(w);
  }
}
