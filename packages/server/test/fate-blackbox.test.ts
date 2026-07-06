// 裁判 fate 投票の判例化 (fate-blackbox + LlmBrain.groupVoteFate) のテスト。
// LLM は fake クライアント (createClient DI) で決定的に差し替える。

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FateVoteContext, Villager, Incident } from '@pagus/sim';
import { LlmBrain } from '../src/llm/llm-brain.js';
import { BackendRegistry, DEFAULT_CAST, DEFAULT_STRONG } from '../src/llm/backend-registry.js';
import type { LlmClient } from '../src/llm/llm-client.js';
import {
  DOMAIN_TRIAL_FATE, fateFeatures, makeTrialFateBlackBox, parseProposedFateRule,
} from '../src/llm/fate-blackbox.js';

function villager(over: Partial<Villager> = {}): Villager {
  return {
    id: 'v1',
    name: 'テスト猫',
    alive: true,
    persona: {
      traits: { kindness: 0.2, aggression: 0.9, sociability: 0.5, curiosity: 0.4, discipline: 0.3, ambition: 0.6 },
      values: ['強さ'],
      speechStyle: 'ぶっきらぼう',
    },
    emotion: { axes: {}, label: 'ふつう' },
    information: [],
    position: { x: 0, y: 0 },
    appearance: { body: 'cat', descriptors: [] },
    species: '猫',
    activity: 'diurnal',
    reformCount: 1,
    madman: false,
    stress: 3,
    partnerId: null,
    origin: 'seed',
    eventParams: {},
    wealth: 100,
    hobby: 'ascetic',
    admireId: null,
    scummy: false,
    ...over,
  } as Villager;
}

function incident(damage = 42): Incident {
  return {
    id: 'i1',
    perpetrator: 'v1',
    involved: ['v2', 'v3'],
    description: '広場で喧嘩',
    damage,
    steps: [],
    resolved: true,
  };
}

function fateCtx(damage = 42): FateVoteContext {
  return { axis: 'aggression', voters: [], defendant: villager(), incident: incident(damage) };
}

/** 常に同じ JSON を返す fake LLM クライアント。呼び出し回数を数える。 */
function fakeClient(json: string, counter: { calls: number }): () => LlmClient {
  return () => ({
    invoke: async () => {
      counter.calls += 1;
      return { text: json };
    },
  });
}

const KILL_WITH_RULE = JSON.stringify({
  verdict: 'kill',
  confidence: 0.9,
  rationale: '攻撃性グループは重罪に厳しい',
  proposedRule: {
    description: '攻撃性グループは被害30超で kill',
    when: {
      op: 'and',
      clauses: [
        { op: 'cmp', feature: 'axis', cmp: '==', value: 'aggression' },
        { op: 'cmp', feature: 'damage', cmp: '>=', value: 30 },
      ],
    },
    output: { verdict: 'kill' },
    confidence: 0.8,
  },
});

function tmpBb() {
  return makeTrialFateBlackBox(join(mkdtempSync(join(tmpdir(), 'pagus-bb-')), 'blackbox.json'));
}

function brainWith(bb: ReturnType<typeof makeTrialFateBlackBox>, counter: { calls: number }, json = KILL_WITH_RULE): LlmBrain {
  const registry = new BackendRegistry({ cast: DEFAULT_CAST, strong: DEFAULT_STRONG });
  return new LlmBrain(registry, { createClient: fakeClient(json, counter), fateBlackbox: bb });
}

describe('fateFeatures', () => {
  it('判例向けのフラット特徴量 (一過性 id を含まない)', () => {
    const f = fateFeatures(fateCtx());
    expect(f.axis).toBe('aggression');
    expect(f.damage).toBe(42);
    expect(f.involvedCount).toBe(2);
    expect(f.reformCount).toBe(1);
    expect(f.dominantTrait).toBe('aggression');
    expect(f.aggression).toBe(0.9);
    expect(Object.values(f).some((v) => v === 'v1' || v === 'テスト猫')).toBe(false);
  });
});

describe('parseProposedFateRule', () => {
  it('不正な when は undefined (落とさない)', () => {
    expect(parseProposedFateRule({ when: { op: 'bogus' } }, 'kill')).toBeUndefined();
    expect(parseProposedFateRule(null, 'kill')).toBeUndefined();
  });
  it('output.verdict が不正なら LLM の実投票で補完', () => {
    const p = parseProposedFateRule(
      { when: { op: 'cmp', feature: 'damage', cmp: '>=', value: 10 }, output: { verdict: 'maim' } },
      'spare',
    );
    expect((p?.output as { verdict: string }).verdict).toBe('spare');
  });
});

describe('LlmBrain.groupVoteFate × blackbox (判例の成長)', () => {
  it('LLM 投票を教師に判例が育ち、trial 発火で LLM を呼ばなくなる', async () => {
    const bb = tmpBb();
    const counter = { calls: 0 };
    const brain = brainWith(bb, counter);

    // 1回目: 提案 / 2〜4回目: 影一致 ×3 → trial 昇格
    for (let i = 0; i < 4; i++) {
      expect(await brain.groupVoteFate(fateCtx())).toBe('kill');
    }
    expect(counter.calls).toBe(4);
    const rules = bb.engine.listRules(DOMAIN_TRIAL_FATE);
    expect(rules).toHaveLength(1);
    expect(rules[0].state).toBe('trial');

    // 5回目: 判例が発火して LLM 不要。レビューキューに載る
    expect(await brain.groupVoteFate(fateCtx(55))).toBe('kill');
    expect(counter.calls).toBe(4);
    expect(bb.ledger.listPending(DOMAIN_TRIAL_FATE)).toHaveLength(1);
  });

  it('OK×3 で判例が auto 卒業し、以後キューにも載らない', async () => {
    const bb = tmpBb();
    const counter = { calls: 0 };
    const brain = brainWith(bb, counter);
    for (let i = 0; i < 4; i++) await brain.groupVoteFate(fateCtx());
    for (let i = 0; i < 3; i++) {
      await brain.groupVoteFate(fateCtx());
      const [pending] = bb.ledger.listPending(DOMAIN_TRIAL_FATE, 1);
      bb.engine.recordVerdict(pending.id, 'ok');
    }
    expect(bb.engine.listRules(DOMAIN_TRIAL_FATE)[0].state).toBe('auto');
    await brain.groupVoteFate(fateCtx());
    expect(counter.calls).toBe(4);
    expect(bb.ledger.listPending(DOMAIN_TRIAL_FATE)).toHaveLength(0);
    expect(bb.stats(DOMAIN_TRIAL_FATE).ruleCoverage).toBeGreaterThan(0);
  });

  it('条件不一致 (軽微な被害) なら判例は発火せず LLM に戻る', async () => {
    const bb = tmpBb();
    const counter = { calls: 0 };
    const brain = brainWith(bb, counter);
    for (let i = 0; i < 4; i++) await brain.groupVoteFate(fateCtx()); // trial 化
    await brain.groupVoteFate(fateCtx(5)); // damage 5 < 30 → 判例対象外
    expect(counter.calls).toBe(5);
  });

  it('fateBlackbox 未指定なら従来経路 (毎回 LLM)', async () => {
    const counter = { calls: 0 };
    const registry = new BackendRegistry({ cast: DEFAULT_CAST, strong: DEFAULT_STRONG });
    const brain = new LlmBrain(registry, {
      createClient: fakeClient(JSON.stringify({ verdict: 'spare' }), counter),
    });
    for (let i = 0; i < 3; i++) {
      expect(await brain.groupVoteFate(fateCtx())).toBe('spare');
    }
    expect(counter.calls).toBe(3);
  });
});
