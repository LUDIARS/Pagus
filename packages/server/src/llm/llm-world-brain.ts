// 実 LLM 駆動の WorldBrain 実装。
// その日の裁判結果から村全体を評価する。重い局面なので strong tier (opus/gpt-5.5) 固定。
// parse 失敗は 1 回リトライ→なお失敗なら throw (無言フォールバック禁止)。

import type {
  WorldBrain,
  WorldEvalContext,
  DayEvaluation,
  HolidayContext,
  HolidayEvent,
  MonthlyScheduleContext,
  MonthlySchedule,
  IncidentDesignContext,
  IncidentDesign,
  RuleProposalContext,
  BehaviorRule,
  DistillContext,
} from '@pagus/sim';

import { estimateTokens } from '@ludiars/llm-gateway';

import type { LlmClient } from './llm-client.js';
import { CliLlmClient, type CliLlmClientOptions } from './cli-llm-client.js';
import { BackendRegistry } from './backend-registry.js';
import type { Backend } from './backend-registry.js';
import type { CostSink } from './cost-log.js';
import { buildWorldPrompt, buildHolidayPrompt, buildSchedulePrompt, buildDesignPrompt, buildRulePrompt, buildDistillPrompt, type PromptParts } from './prompt-build.js';
import {
  extractJson,
  coerceDayEvaluation,
  coerceHolidayEvent,
  coerceMonthlySchedule,
  coerceIncidentDesign,
  coerceBehaviorRule,
} from './json-coerce.js';

/** RuleSmith は Haiku 固定 (cheap・低頻度なのでコスト方針と両立, §2.1)。 */
const RULE_BACKEND: Backend = { id: 'haiku', provider: 'claude', model: 'claude-haiku-4-5' };

export interface LlmWorldBrainOptions {
  createClient?: (backend: Backend) => LlmClient;
  timeoutMs?: number;
  /** CLI の一過性失敗リトライ回数 (PagusConfig.llm.cliRetries)。 */
  retries?: number;
  /** LLM 呼び出しごとのコスト計上フック (§7)。未指定なら計上しない。 */
  costSink?: CostSink;
}

export class LlmWorldBrain implements WorldBrain {
  private readonly registry: BackendRegistry;
  private readonly createClient: (backend: Backend) => LlmClient;
  private readonly clients = new Map<string, LlmClient>();
  private readonly costSink: CostSink | undefined;

  constructor(registry: BackendRegistry, opts: LlmWorldBrainOptions = {}) {
    this.registry = registry;
    this.costSink = opts.costSink;
    const timeoutMs = opts.timeoutMs;
    const retries = opts.retries;
    this.createClient =
      opts.createClient ??
      ((backend: Backend): LlmClient => {
        const o: CliLlmClientOptions = { provider: backend.provider, model: backend.model };
        if (timeoutMs !== undefined) o.timeoutMs = timeoutMs;
        if (retries !== undefined) o.retries = retries;
        return new CliLlmClient(o);
      });
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
      this.reportCost(parts, backend, text);
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
      this.reportCost(parts, backend, text);
      try {
        return coerceHolidayEvent(extractJson(text));
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`祝日イベントの parse に失敗 (backend=${backend.id}): ${(lastErr as Error).message}`);
  }

  async scheduleMonthlyIncident(ctx: MonthlyScheduleContext): Promise<MonthlySchedule> {
    const parts = buildSchedulePrompt(ctx);
    // 月初の発生日決定は重い局面 → strong tier。年月を決定的キーに。
    const backend = this.registry.strong(`schedule:${ctx.calendar.year}:${ctx.calendar.month}`);
    const client = this.clientFor(backend);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await client.invoke({
        system: parts.system,
        prompt: parts.prompt,
        model: backend.model,
      });
      this.reportCost(parts, backend, text);
      try {
        return coerceMonthlySchedule(extractJson(text));
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`月次スケジュールの parse に失敗 (backend=${backend.id}): ${(lastErr as Error).message}`);
  }

  async designIncident(ctx: IncidentDesignContext): Promise<IncidentDesign> {
    const parts = buildDesignPrompt(ctx);
    // 事件の詳細デザインは重い局面 → strong tier。年月日を決定的キーに。
    const cal = ctx.calendar;
    const backend = this.registry.strong(`design:${cal.year}:${cal.month}:${cal.dayOfMonth}`);
    const client = this.clientFor(backend);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await client.invoke({
        system: parts.system,
        prompt: parts.prompt,
        model: backend.model,
      });
      this.reportCost(parts, backend, text);
      try {
        return coerceIncidentDesign(extractJson(text));
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`事件デザインの parse に失敗 (backend=${backend.id}): ${(lastErr as Error).message}`);
  }

  async proposeRule(ctx: RuleProposalContext): Promise<BehaviorRule> {
    const parts = buildRulePrompt(ctx);
    // ルール起案は Haiku 固定 (cheap・低頻度, §2.1)。registry の strong (opus) には寄せない。
    const backend = RULE_BACKEND;
    const client = this.clientFor(backend);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await client.invoke({
        system: parts.system,
        prompt: parts.prompt,
        model: backend.model,
      });
      this.reportCost(parts, backend, text);
      try {
        return coerceBehaviorRule(extractJson(text));
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`ふるまいの法則の parse に失敗 (backend=${backend.id}): ${(lastErr as Error).message}`);
  }

  /** 乖離ケースを説明するルールを蒸留する (§v1.4-C)。RuleSmith 同様 Haiku 固定 (cheap)。 */
  async distillRule(ctx: DistillContext): Promise<BehaviorRule> {
    const parts = buildDistillPrompt(ctx);
    const backend = RULE_BACKEND;
    const client = this.clientFor(backend);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await client.invoke({
        system: parts.system,
        prompt: parts.prompt,
        model: backend.model,
      });
      this.reportCost(parts, backend, text);
      try {
        return coerceBehaviorRule(extractJson(text));
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`蒸留ルールの parse に失敗 (backend=${backend.id}): ${(lastErr as Error).message}`);
  }

  private clientFor(backend: Backend): LlmClient {
    let c = this.clients.get(backend.id);
    if (!c) {
      c = this.createClient(backend);
      this.clients.set(backend.id, c);
    }
    return c;
  }

  /** 成功した invoke のコストを計上する (§7)。 */
  private reportCost(parts: PromptParts, backend: Backend, text: string): void {
    this.costSink?.({
      kind: parts.kind,
      provider: backend.provider,
      model: backend.model,
      inTokens: estimateTokens(parts.system) + estimateTokens(parts.prompt),
      outTokens: estimateTokens(text),
    });
  }
}
