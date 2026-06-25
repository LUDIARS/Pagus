// LLM バックエンドのキャスティング。
//
// マルチモデル分散: 村人ごとに backend (provider+model) を準固定で割り当て、
// 「村人それぞれが別 LLM の脳で動く」創発を作る。重い局面 (裁判/教育/世界評価) は
// strong tier (opus / gpt-5.5) へ寄せる override を別途持つ。
//
// Discutere の DEFAULT_WORKERS (`persona-prompts.ts`) をミラー: claude(opus/sonnet/haiku)
// に codex(gpt-5.5) を混ぜたキャスト。codex 経由で GPT-5.5 = `codex --model gpt-5.5`。

import type { CliProvider } from './cli-llm-client.js';

/** 1 つの LLM バックエンド。 */
export interface Backend {
  /** キャッシュ/ログ用の安定 id。 */
  id: string;
  provider: CliProvider;
  model: string;
}

/**
 * デフォルトキャスト = claude 3 モデルのみ。
 * codex(gpt-5.5) は一過性の `exit 1` が安定するまで既定から外し、
 * `PAGUS_ENABLE_CODEX=1` のとき index.ts が GPT_BACKEND を足す。
 */
export const DEFAULT_CAST: readonly Backend[] = [
  { id: 'opus', provider: 'claude', model: 'claude-opus-4-8' },
  { id: 'sonnet', provider: 'claude', model: 'claude-sonnet-4-6' },
  { id: 'haiku', provider: 'claude', model: 'claude-haiku-4-5' },
] as const;

/** 重い局面で寄せる strong tier (既定 = opus)。 */
export const DEFAULT_STRONG: readonly Backend[] = [
  { id: 'opus', provider: 'claude', model: 'claude-opus-4-8' },
] as const;

/** codex 経由の GPT-5.5。`PAGUS_ENABLE_CODEX=1` で cast/strong へ合流させる。 */
export const GPT_BACKEND: Backend = { id: 'gpt', provider: 'codex', model: 'gpt-5.5' };

export interface BackendRegistryOptions {
  /** キャスト全体 (per-villager 割当の母集合)。既定 DEFAULT_CAST。 */
  cast?: readonly Backend[];
  /** strong tier の母集合。既定 DEFAULT_STRONG。 */
  strong?: readonly Backend[];
  /**
   * seed 由来の初期割当 (villagerId → backend.id)。
   * 指定があれば hash 割当より優先する (= seed を尊重)。
   */
  initialAssignments?: Readonly<Record<string, string>>;
}

/**
 * villager → backend の準固定割当を管理する。
 * 割当は villagerId のハッシュで決定的に決まる (= 再起動しても同じ脳)。
 */
export class BackendRegistry {
  private readonly cast: readonly Backend[];
  private readonly strongCast: readonly Backend[];
  private readonly byId: Map<string, Backend>;
  private readonly initial: Readonly<Record<string, string>>;
  /** 解決済み割当のメモ化。 */
  private readonly assigned = new Map<string, Backend>();

  constructor(opts: BackendRegistryOptions = {}) {
    this.cast = opts.cast ?? DEFAULT_CAST;
    this.strongCast = opts.strong ?? DEFAULT_STRONG;
    if (this.cast.length === 0) throw new Error('BackendRegistry: cast が空です');
    if (this.strongCast.length === 0) throw new Error('BackendRegistry: strong が空です');
    this.byId = new Map(this.cast.map((b) => [b.id, b]));
    for (const b of this.strongCast) if (!this.byId.has(b.id)) this.byId.set(b.id, b);
    this.initial = opts.initialAssignments ?? {};
  }

  /** villager の既定バックエンド (tick/感情/行動など軽い局面)。 */
  assign(villagerId: string): Backend {
    const memo = this.assigned.get(villagerId);
    if (memo) return memo;

    // seed 初期割当を尊重。
    const pinned = this.initial[villagerId];
    if (pinned !== undefined) {
      const b = this.byId.get(pinned);
      if (!b) {
        throw new Error(
          `初期割当 backend '${pinned}' (villager ${villagerId}) がキャストに存在しません`,
        );
      }
      this.assigned.set(villagerId, b);
      return b;
    }

    const idx = hashString(villagerId) % this.cast.length;
    const picked = this.cast[idx];
    if (!picked) throw new Error('BackendRegistry: キャスト選択に失敗しました');
    this.assigned.set(villagerId, picked);
    return picked;
  }

  /**
   * 重い局面の strong バックエンド。
   * key (villagerId など) を与えると strong 母集合から決定的に 1 つ選ぶ。
   * 無指定なら先頭 (opus)。
   */
  strong(key?: string): Backend {
    if (key === undefined) {
      const first = this.strongCast[0];
      if (!first) throw new Error('BackendRegistry: strong が空です');
      return first;
    }
    const idx = hashString(key) % this.strongCast.length;
    const picked = this.strongCast[idx];
    if (!picked) throw new Error('BackendRegistry: strong 選択に失敗しました');
    return picked;
  }
}

/** 決定的な文字列ハッシュ (FNV-1a 32bit)。 */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
