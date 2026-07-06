// Shadow sampling (§v1.4-C)。日常 tick の一部で、生徒 (DailyEngine) が下した決定と同じ文脈を
// 教師 (Brain = llm モードでは LLM) にも fire-and-forget で問い、乖離を DivergenceLog に記録する。
// sim の進行は一切ブロックしない (観測専用)。llm モードの追加費用はサンプル率で制御する。

import type { Brain, ActionDecision, EnvironmentView, Villager, DivergenceCase } from '@pagus/sim';
import type { DivergenceLog } from './divergence-log.js';

export interface ShadowSamplerOptions {
  /** 同時に飛ばす教師呼び出しの上限 (溜まり防止)。既定 1。 */
  maxInFlight?: number;
}

const EPS = 1e-9;

function sign(n: number): -1 | 0 | 1 {
  if (n > EPS) return 1;
  if (n < -EPS) return -1;
  return 0;
}

/** 感情ベクトルの差分 (after - before)。 */
function emotionDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    out[k] = (after[k] ?? 0) - (before[k] ?? 0);
  }
  return out;
}

/** 主要軸の符号が食い違うか (乖離判定の感情側)。 */
function emotionDiverged(student: Record<string, number>, teacher: Record<string, number>): boolean {
  let axis: string | null = null;
  let best = EPS;
  for (const [k, d] of Object.entries(teacher)) {
    if (Math.abs(d) > best) {
      best = Math.abs(d);
      axis = k;
    }
  }
  if (axis === null) return false; // 教師が感情を動かしていなければ感情側の乖離は問わない
  return sign(student[axis] ?? 0) !== sign(teacher[axis] ?? 0);
}

export class ShadowSampler {
  private inFlight = 0;
  private readonly maxInFlight: number;
  /** テスト用: 直近の全呼び出しの完了を待てるように保持。 */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly teacher: Brain,
    private readonly log: DivergenceLog,
    opts: ShadowSamplerOptions = {},
  ) {
    this.maxInFlight = opts.maxInFlight ?? 1;
  }

  /**
   * 生徒の決定 1 件を教師に影として問う (fire-and-forget)。
   * in-flight 上限を超えたら黙って捨てる (観測のサンプリングであり、取りこぼしは仕様)。
   */
  sample(villager: Villager, env: EnvironmentView, studentDecision: ActionDecision, term: number): void {
    if (this.inFlight >= this.maxInFlight) return;
    this.inFlight += 1;
    // 教師呼び出し中に sim が村人を書き換えるため、文脈は今スナップショットする。
    const frozenVillager = structuredClone(villager);
    const frozenEnv = structuredClone(env);
    const beforeEmotion = { ...villager.emotion.axes };
    const run = (async () => {
      try {
        const teacherDecision = await this.teacher.decideAction({
          villager: frozenVillager,
          environment: frozenEnv,
          directive: null,
        });
        const studentDelta = emotionDelta(beforeEmotion, studentDecision.newEmotion.axes);
        const teacherDelta = emotionDelta(beforeEmotion, teacherDecision.newEmotion.axes);
        const diverged =
          teacherDecision.triggersIncident !== studentDecision.triggersIncident ||
          emotionDiverged(studentDelta, teacherDelta);
        this.log.record(this.toCase(frozenVillager, frozenEnv, studentDecision, teacherDelta, teacherDecision, term), diverged);
      } catch (e) {
        // 観測専用: 教師の失敗は sim に波及させない (feed も汚さない)。
        console.error('[pagus] shadow sampling 失敗', e);
      } finally {
        this.inFlight -= 1;
      }
    })();
    this.tail = this.tail.then(() => run);
  }

  /** テスト用: 飛ばした教師呼び出しの完了を待つ。 */
  flush(): Promise<void> {
    return this.tail;
  }

  private toCase(
    v: Villager,
    env: EnvironmentView,
    student: ActionDecision,
    teacherDelta: Record<string, number>,
    teacher: ActionDecision,
    term: number,
  ): DivergenceCase {
    return {
      term,
      villager: {
        id: v.id,
        species: v.species,
        traits: { ...v.persona.traits },
        emotionAxes: { ...v.emotion.axes },
        eventParams: { ...v.eventParams },
        wealth: v.wealth,
        stress: v.stress,
        infoTexts: v.information.slice(-5).map((i) => i.text),
        infoFromPlayer: v.information.some((i) => i.source === 'player'),
      },
      env: {
        place: env.place,
        timeOfDay: env.timeOfDay,
        hasNeighbor: env.nearby.length > 0,
        ...(env.placeState !== undefined ? { placeState: env.placeState } : {}),
      },
      category: student.triggersIncident ? 'harass' : 'wander',
      teacher: {
        emotionDelta: teacherDelta,
        triggersIncident: teacher.triggersIncident,
      },
      student: {
        triggersIncident: student.triggersIncident,
      },
    };
  }
}
