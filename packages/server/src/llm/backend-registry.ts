// LLM バックエンドのキャスティング。
//
// マルチモデル分散: 村人ごとに backend (provider+model) を準固定で割り当て、
// 「村人それぞれが別 LLM の脳で動く」創発を作る。重い局面 (裁判/教育/世界評価) は
// strong tier (opus / GPT-5.6 Sol) へ寄せる override を別途持つ。

import type { CliProvider } from './cli-llm-client.js';

/** 1 つの LLM バックエンド。 */
export interface Backend {
  /** キャッシュ/ログ用の安定 id。 */
  id: string;
  provider: CliProvider;
  model: string;
}

/**
 * Codex 無効時のフォールバックキャスト = Claude 3 モデル。
 */
export const OPUS_BACKEND: Backend = { id: 'opus', provider: 'claude', model: 'claude-opus-4-8' };
export const SONNET_BACKEND: Backend = { id: 'sonnet', provider: 'claude', model: 'claude-sonnet-4-6' };
export const HAIKU_BACKEND: Backend = { id: 'haiku', provider: 'claude', model: 'claude-haiku-4-5' };

export const DEFAULT_CAST: readonly Backend[] = [
  OPUS_BACKEND,
  SONNET_BACKEND,
  HAIKU_BACKEND,
] as const;

/** 重い局面で寄せる strong tier (既定 = opus)。 */
export const DEFAULT_STRONG: readonly Backend[] = [
  OPUS_BACKEND,
] as const;

/** Codex CLI で使う GPT-5.6 family のモデル ID。 */
export const GPT_SOL_MODEL = 'gpt-5.6-sol';
export const GPT_TERRA_MODEL = 'gpt-5.6-terra';
export const GPT_LUNA_MODEL = 'gpt-5.6-luna';

export const GPT_SOL_BACKEND: Backend = { id: 'gpt-sol', provider: 'codex', model: GPT_SOL_MODEL };
export const GPT_TERRA_BACKEND: Backend = { id: 'gpt-terra', provider: 'codex', model: GPT_TERRA_MODEL };
export const GPT_LUNA_BACKEND: Backend = { id: 'gpt-luna', provider: 'codex', model: GPT_LUNA_MODEL };

/** 通常の住民脳: Sol 2 / Terra 4 / Luna 2 / Sonnet 2 の 10 枠配備。 */
export const GPT56_CAST: readonly Backend[] = [
  GPT_SOL_BACKEND,
  GPT_TERRA_BACKEND,
  GPT_LUNA_BACKEND,
  SONNET_BACKEND,
] as const;

export const GPT56_ASSIGNMENT_WEIGHTS = {
  'gpt-sol': 2,
  'gpt-terra': 4,
  'gpt-luna': 2,
  sonnet: 2,
} as const satisfies Readonly<Record<string, number>>;

/** 事件・裁判・教育などの強い役割は Sol 固定。 */
export const GPT56_STRONG: readonly Backend[] = [GPT_SOL_BACKEND] as const;

export interface BackendRegistryOptions {
  /** キャスト全体 (per-villager 割当の母集合)。既定 DEFAULT_CAST。 */
  cast?: readonly Backend[];
  /** strong tier の母集合。既定 DEFAULT_STRONG。 */
  strong?: readonly Backend[];
  /** per-villager assignment weights by backend id. Display cast remains unique. */
  assignmentWeights?: Readonly<Record<string, number>>;
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
  private readonly assignmentCast: readonly Backend[];
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
    this.assignmentCast = buildAssignmentCast(this.cast, this.byId, opts.assignmentWeights);
    this.initial = opts.initialAssignments ?? {};
  }

  /** キャスト全体 (UI 表示用)。 */
  get backends(): readonly Backend[] {
    return this.cast;
  }

  /** strong tier 一覧 (UI 表示用)。 */
  get strongBackends(): readonly Backend[] {
    return this.strongCast;
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

    const idx = hashString(villagerId) % this.assignmentCast.length;
    const picked = this.assignmentCast[idx];
    if (!picked) throw new Error('BackendRegistry: キャスト選択に失敗しました');
    this.assigned.set(villagerId, picked);
    return picked;
  }

  pruneAssignments(activeVillagerIds: ReadonlySet<string>): number {
    let removed = 0;
    for (const villagerId of this.assigned.keys()) {
      if (activeVillagerIds.has(villagerId)) continue;
      this.assigned.delete(villagerId);
      removed += 1;
    }
    return removed;
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
function buildAssignmentCast(
  cast: readonly Backend[],
  byId: ReadonlyMap<string, Backend>,
  weights: Readonly<Record<string, number>> | undefined,
): readonly Backend[] {
  if (!weights) return cast;
  const expanded: Backend[] = [];
  for (const [id, rawWeight] of Object.entries(weights)) {
    const backend = byId.get(id);
    if (!backend) throw new Error(`BackendRegistry: assignment weight references unknown backend '${id}'`);
    const weight = Math.floor(rawWeight);
    if (weight <= 0) continue;
    for (let i = 0; i < weight; i += 1) expanded.push(backend);
  }
  return expanded.length > 0 ? expanded : cast;
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
