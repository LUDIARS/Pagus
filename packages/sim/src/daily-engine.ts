// 日常エンジン (BT / ブラックボックス) — LLM を一切呼ばずに起の行動を決める (§12.2)。
//
// コスト削減リデザイン v1.0: 日常 (起の毎セグメント) から LLM を外し、決定的な
// ルール/重み + アルゴリズム感情変異で行動を生成する。LLM は事件デザイン・事件中の
// 当事者応答・裁判だけに限定する (Brain interface 越し)。
//
// EventDirector が差配する directive (グループ代表 × カテゴリ) を narration し、
// 嫌がらせは事件化させる。directive 無し (自由行動) は行動回数・扇動・イベント由来
// パラメータ (§12.6) を踏まえて確率的に事件化する。

import type { Villager, EmotionState } from './types/index.js';
import type { ActionDecision, EnvironmentView } from './brain.js';
import type { EventDirective } from './events.js';

/** 事件をくぐった反応として溜まるイベント由来パラメータのタグ。 */
export const REACTION_EXPOSURE = 'incidentExposure';

export interface DailyEngineOptions {
  /** 乱数源 (既定 Math.random)。 */
  rng?: () => number;
  /**
   * 自由行動がこの回数に達すると (周囲に住民がいれば) 事件化する。既定 6。
   * 扇動 (forceNext) と イベント由来パラメータ (§12.6) で前倒しされる。
   */
  triggerAfter?: number;
}

/** 感情軸を -1..1 にクランプ。 */
function clampAxis(n: number): number {
  return Math.min(1, Math.max(-1, n));
}

/**
 * 行動カテゴリに応じて感情をアルゴリズム変異させる (§12.2: 感情= AI→プログラム)。
 * LLM を呼ばずに anger/joy/fear を小さく揺らし、ラベルを言語化する。
 */
function nudgeEmotion(base: EmotionState, kind: 'harass' | 'good' | 'chat' | 'wander'): EmotionState {
  const axes = { ...base.axes };
  const bump = (k: string, d: number): void => {
    axes[k] = clampAxis((axes[k] ?? 0) + d);
  };
  if (kind === 'harass') {
    bump('anger', 0.2);
    bump('joy', -0.1);
  } else if (kind === 'good') {
    bump('joy', 0.15);
    bump('anger', -0.1);
  } else if (kind === 'chat') {
    bump('joy', 0.05);
  } else {
    // wander: 落ち着きへ緩やかに回帰。
    bump('anger', -0.05);
  }
  const label = (axes['anger'] ?? 0) > 0.4 ? 'いらだち' : (axes['joy'] ?? 0) > 0.4 ? 'ごきげん' : 'ふつう';
  return { axes, label };
}

/**
 * 日常 (起) の行動を LLM 非依存で決める。TermMachine が kishoTick から呼ぶ。
 * 状態 (行動カウンタ・扇動フラグ) を持つので TermMachine が 1 個保持する。
 */
export class DailyEngine {
  private readonly rng: () => number;
  private readonly triggerAfter: number;
  /** 自由行動の通算回数 (事件化判定の基準)。 */
  private actionCount = 0;
  /** プレイヤーの扇動: 次に周囲がいる自由行動で必ず事件化する。 */
  private forced = false;

  constructor(opts: DailyEngineOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.triggerAfter = opts.triggerAfter ?? 6;
  }

  /** プレイヤーの扇動 (§12.4)。次の自由行動で事件化を促す。 */
  forceNext(): void {
    this.forced = true;
  }

  /** 起の 1 行動を決める。directive があれば差配を narration、無ければ自由行動。 */
  decide(villager: Villager, env: EnvironmentView, directive: EventDirective | null): ActionDecision {
    const move = this.wander(villager, env);
    if (directive) return this.narrate(villager, env, directive, move);
    return this.freeAction(villager, env, move);
  }

  /** directive 無しの自由行動。カウンタ/扇動/イベント由来パラメータで事件化する。 */
  private freeAction(villager: Villager, env: EnvironmentView, move: { x: number; y: number }): ActionDecision {
    this.actionCount += 1;
    const hasNeighbor = env.nearby.length > 0;
    // イベント由来パラメータ (殺人を見た等) が高い個体ほど閾値が下がり、事件を起こしやすい。
    const exposure = villager.eventParams[REACTION_EXPOSURE] ?? 0;
    const threshold = Math.max(1, this.triggerAfter - exposure);
    const trigger = hasNeighbor && (this.forced || this.actionCount >= threshold);
    if (trigger) this.forced = false;
    return {
      move,
      action: `${villager.name} は ${env.place} をうろついた`,
      newEmotion: nudgeEmotion(villager.emotion, trigger ? 'harass' : 'wander'),
      triggersIncident: trigger,
      incidentSeed: trigger
        ? {
            description: `${villager.name} が ${env.place} で騒ぎを起こした`,
            involved: env.nearby.map((n) => n.id),
          }
        : null,
    };
  }

  /** EventDirector が差配したイベントを narration する。嫌がらせは事件化。 */
  private narrate(
    villager: Villager,
    env: EnvironmentView,
    d: EventDirective,
    move: { x: number; y: number },
  ): ActionDecision {
    const name = villager.name;
    if (d.category === 'harass' && d.target) {
      return {
        move,
        action: `${name} は誰かに嫌がらせをした`,
        newEmotion: nudgeEmotion(villager.emotion, 'harass'),
        triggersIncident: true,
        incidentSeed: { description: `${name} が嫌がらせをした`, involved: [d.target] },
      };
    }
    const kind = d.category === 'good' ? 'good' : 'chat';
    const text =
      d.category === 'good' ? `${name} は ${env.place} で良い行いをした` : `${name} は雑談した`;
    return { move, action: text, newEmotion: nudgeEmotion(villager.emotion, kind), triggersIncident: false, incidentSeed: null };
  }

  /** 1 マスのうろつき移動 (rng で 8 近傍 + 留まる)。 */
  private wander(villager: Villager, _env: EnvironmentView): { x: number; y: number } {
    const dx = Math.floor(this.rng() * 3) - 1;
    const dy = Math.floor(this.rng() * 3) - 1;
    return { x: villager.position.x + dx, y: villager.position.y + dy };
  }
}
