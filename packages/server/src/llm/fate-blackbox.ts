// 裁判 fate 投票 (kill/spare) の「判例化」 — 成長型ブラックボックス (@ludiars/blackbox)。
//
// 各性格グループの投票は strong tier LLM (裁判ごと×グループ数) で高コスト。
// LLM の投票を教師に「axis=X かつ damage>=N なら kill」のような判例ルールを育て、
// 影評価 → trial 発火 → 人間 OK×3 (HTTP /api/blackbox) で auto 卒業 =
// そのグループの量刑判断に LLM を呼ばなくなる。村に「判例法」が創発する。
//
// 永続化は world.json と同じ流儀の JSON ファイル (data/runtime/blackbox.json)。
// 設計正本: Lapilli packages/blackbox/DESIGN.md §7。

import {
  validateCondition,
  type BlackBox, type FeatureMap, type LlmJudgement,
} from '@ludiars/blackbox';
import { makeFileBlackBox } from '@ludiars/blackbox/file';
import { PERSONALITY_AXES } from '@pagus/sim';
import type { FateVoteContext } from '@pagus/sim';

export const DOMAIN_TRIAL_FATE = 'pagus.trial_fate';

export interface FateOutput {
  verdict: 'kill' | 'spare';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 量刑判断の特徴量。ルール (判例) はこの map だけを見る。
 * 村人 id 等の一過性の値は入れない (世代を跨いで通用する判例にするため)。
 */
export function fateFeatures(ctx: FateVoteContext): FeatureMap {
  const traits = ctx.defendant.persona.traits;
  let dominantTrait: string = PERSONALITY_AXES[0];
  for (const axis of PERSONALITY_AXES) {
    if (traits[axis] > traits[dominantTrait as (typeof PERSONALITY_AXES)[number]]) dominantTrait = axis;
  }
  return {
    axis: ctx.axis,
    damage: Math.round(ctx.incident.damage),
    involvedCount: ctx.incident.involved.length,
    reformCount: ctx.defendant.reformCount,
    madman: ctx.defendant.madman,
    scummy: ctx.defendant.scummy,
    stress: Math.round(ctx.defendant.stress),
    dominantTrait,
    aggression: round2(traits.aggression),
    kindness: round2(traits.kindness),
  };
}

/** LLM 応答の proposedRule (raw) を検証して blackbox 提案形式に直す。不正は undefined。 */
export function parseProposedFateRule(
  raw: unknown,
  verdict: 'kill' | 'spare',
): LlmJudgement<FateOutput>['proposedRule'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  try {
    const when = validateCondition(r.when);
    const out = (r.output as { verdict?: unknown } | undefined)?.verdict;
    const ruleVerdict = out === 'kill' || out === 'spare' ? out : verdict;
    return {
      description: typeof r.description === 'string' ? r.description : `判例: ${ruleVerdict}`,
      when,
      output: { verdict: ruleVerdict },
      confidence: typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : 0.7,
    };
  } catch {
    return undefined;
  }
}

/**
 * 判例 blackbox を作る。LLM 判断はレビューキューに載せない (ゲームの回転が速く
 * 溢れるため)。人間レビューは trial 判例の発火分のみ = キューが判例候補に絞られる。
 */
export function makeTrialFateBlackBox(path: string): BlackBox {
  return makeFileBlackBox(path, { reviewLlmDecisions: false });
}
