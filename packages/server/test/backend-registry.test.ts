import { describe, expect, it } from 'vitest';
import { BackendRegistry, type Backend } from '../src/llm/index.js';

const sonnet: Backend = { id: 'sonnet', provider: 'claude', model: 'sonnet-test' };
const haiku: Backend = { id: 'haiku', provider: 'claude', model: 'haiku-test' };
const gpt: Backend = { id: 'gpt', provider: 'codex', model: 'gpt-test' };

describe('BackendRegistry', () => {
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
});
