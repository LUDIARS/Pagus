// 実 LLM 駆動の WorldBrain 実装。
// その日の裁判結果から村全体を評価する。重い局面なので strong tier (opus/gpt-5.5) 固定。
// parse 失敗は 1 回リトライ→なお失敗なら throw (無言フォールバック禁止)。

import type { WorldBrain, WorldEvalContext, DayEvaluation, HolidayContext, HolidayEvent } from '@pagus/sim';

import type { LlmClient } from './llm-client.js';
import { CliLlmClient } from './cli-llm-client.js';
import { BackendRegistry } from './backend-registry.js';
import type { Backend } from './backend-registry.js';
import { buildWorldPrompt, buildHolidayPrompt } from './prompt-build.js';
import { extractJson, coerceDayEvaluation, coerceHolidayEvent } from './json-coerce.js';

export interface LlmWorldBrainOptions {
  createClient?: (backend: Backend) => LlmClient;
  timeoutMs?: number;
}

export class LlmWorldBrain implements WorldBrain {
  private readonly registry: BackendRegistry;
  private readonly createClient: (backend: Backend) => LlmClient;
  private readonly clients = new Map<string, LlmClient>();

  constructor(registry: BackendRegistry, opts: LlmWorldBrainOptions = {}) {
    this.registry = registry;
    const timeoutMs = opts.timeoutMs;
    this.createClient =
      opts.createClient ??
      ((backend: Backend): LlmClient =>
        new CliLlmClient(
          timeoutMs === undefined
            ? { provider: backend.provider, model: backend.model }
            : { provider: backend.provider, model: backend.model, timeoutMs },
        ));
  }

  async evaluateDay(ctx: WorldEvalContext): Promise<DayEvaluation> {
    const parts = buildWorldPrompt(ctx);
    // 世界評価は重い → strong tier 固定 (incident id をキーに決定的選択)。
    const backend = this.registry.strong(ctx.incident.id);
    const client = this.clientFor(backend);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await client.invoke({
        system: parts.system,
        prompt: parts.prompt,
        model: backend.model,
      });
      try {
        return coerceDayEvaluation(extractJson(text));
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`世界評価の parse に失敗 (backend=${backend.id}): ${(lastErr as Error).message}`);
  }

  async holidayEvent(ctx: HolidayContext): Promise<HolidayEvent> {
    const parts = buildHolidayPrompt(ctx);
    // 祝日名を決定的キーに strong tier を選ぶ (年に数回、軽い局面)。
    const backend = this.registry.strong(`holiday:${ctx.holiday}:${ctx.calendar.year}`);
    const client = this.clientFor(backend);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await client.invoke({
        system: parts.system,
        prompt: parts.prompt,
        model: backend.model,
      });
      try {
        return coerceHolidayEvent(extractJson(text));
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`祝日イベントの parse に失敗 (backend=${backend.id}): ${(lastErr as Error).message}`);
  }

  private clientFor(backend: Backend): LlmClient {
    let c = this.clients.get(backend.id);
    if (!c) {
      c = this.createClient(backend);
      this.clients.set(backend.id, c);
    }
    return c;
  }
}
