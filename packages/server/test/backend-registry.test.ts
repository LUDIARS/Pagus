import { describe, expect, it } from 'vitest';
import {
  BackendRegistry,
  GPT_SOL_BACKEND,
  GPT_TERRA_BACKEND,
  GPT_LUNA_BACKEND,
  GPT56_CAST,
  GPT56_STRONG,
  GPT56_ASSIGNMENT_WEIGHTS,
  type Backend,
} from '../src/llm/index.js';

const sonnet: Backend = { id: 'sonnet', provider: 'claude', model: 'sonnet-test' };
const haiku: Backend = { id: 'haiku', provider: 'claude', model: 'haiku-test' };
const gpt: Backend = { id: 'gpt', provider: 'codex', model: 'gpt-test' };

describe('BackendRegistry', () => {
  it('deploys Sol 2 / Terra 4 / Luna 2 / Sonnet 2 and fixes strong roles to Sol', () => {
    expect(GPT_SOL_BACKEND.model).toBe('gpt-5.6-sol');
    expect(GPT_TERRA_BACKEND.model).toBe('gpt-5.6-terra');
    expect(GPT_LUNA_BACKEND.model).toBe('gpt-5.6-luna');
    expect(GPT56_CAST.map((backend) => backend.id)).toEqual(['gpt-sol', 'gpt-terra', 'gpt-luna', 'sonnet']);
    expect(GPT56_ASSIGNMENT_WEIGHTS).toEqual({ 'gpt-sol': 2, 'gpt-terra': 4, 'gpt-luna': 2, sonnet: 2 });
    expect(GPT56_STRONG).toEqual([GPT_SOL_BACKEND]);
  });

  it('uses assignmentWeights for villager assignment without hiding display backends', () => {
    const registry = new BackendRegistry({
      cast: [sonnet, haiku, gpt],
      strong: [gpt],
      assignmentWeights: { gpt: 1 },
    });

    expect(registry.backends.map((b) => b.id)).toEqual(['sonnet', 'haiku', 'gpt']);
    expect(registry.assign('resident-a').id).toBe('gpt');
    expect(registry.assign('resident-b').id).toBe('gpt');
  });

  it('rejects assignmentWeights that reference an unknown backend', () => {
    expect(
      () =>
        new BackendRegistry({
          cast: [sonnet, haiku],
          strong: [sonnet],
          assignmentWeights: { gpt: 1 },
        }),
    ).toThrow("unknown backend 'gpt'");
  });

  it('releases assignments outside the active working set', () => {
    const registry = new BackendRegistry({ cast: [sonnet, haiku], strong: [sonnet] });
    registry.assign('active');
    registry.assign('retired');
    expect(registry.pruneAssignments(new Set(['active']))).toBe(1);
    expect(registry.pruneAssignments(new Set(['active']))).toBe(0);
    expect(registry.assign('retired')).toBeDefined();
  });
});
