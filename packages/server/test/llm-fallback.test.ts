import { afterEach, describe, it, expect, vi } from 'vitest';
import { createVillager, makeCalendar, makeVirtueVector } from '@pagus/sim';
import { BackendRegistry, LlmBrain, LlmWorldBrain, type LlmClient } from '../src/llm/index.js';

const backend = { id: 'test', provider: 'claude' as const, model: 'test-model' };

function failingClient(counter: { calls: number }): LlmClient {
  return {
    async invoke() {
      counter.calls += 1;
      throw new Error('llm down');
    },
  };
}

describe('LLM fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('個体脳はLLM失敗時にStubBrainへ落ち、同backendをしばらく再試行しない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = { calls: 0 };
    const brain = new LlmBrain(new BackendRegistry({ cast: [backend], strong: [backend] }), {
      createClient: () => failingClient(calls),
      offlineCooldownMs: 60_000,
    });
    const villager = createVillager({ id: 'a', name: 'アオ', position: { x: 1, y: 1 } });
    const ctx = {
      villager,
      directive: null,
      environment: {
        position: villager.position,
        place: '広場',
        timeOfDay: 'morning' as const,
        nearby: [{ id: 'b', name: 'ビワ', pos: { x: 2, y: 1 } }],
      },
    };

    const first = await brain.decideAction(ctx);
    const second = await brain.decideAction(ctx);

    expect(first.action).toContain('アオ');
    expect(second.action).toContain('アオ');
    expect(calls.calls).toBe(1);
  });

  it('世界脳はLLM失敗時にStubWorldBrainへ落ちる', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = { calls: 0 };
    const brain = new LlmWorldBrain(new BackendRegistry({ cast: [backend], strong: [backend] }), {
      createClient: () => failingClient(calls),
      offlineCooldownMs: 60_000,
    });
    const schedule = await brain.scheduleMonthlyIncident({
      calendar: makeCalendar({ year: 2026, month: 7 }),
      reputation: makeVirtueVector(),
      villagers: [],
      villageRules: [],
    });
    const again = await brain.scheduleMonthlyIncident({
      calendar: makeCalendar({ year: 2026, month: 7 }),
      reputation: makeVirtueVector(),
      villagers: [],
      villageRules: [],
    });

    expect(schedule.dayOfMonth).toBe(15);
    expect(again.dayOfMonth).toBe(15);
    expect(calls.calls).toBe(1);
  });
});
