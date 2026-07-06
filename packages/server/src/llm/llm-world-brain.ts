// 実 LLM 駆動の WorldBrain 実装。
// その日の裁判結果から村全体を評価する。重い局面なので strong tier (opus/gpt-5.5) 固定。
// parse/CLI 失敗は 1 回リトライ→なお失敗なら StubWorldBrain にフォールバックする。

import {
  StubWorldBrain,
  type WorldBrain,
  type WorldEvalContext,
  type DayEvaluation,
  type HolidayContext,
  type HolidayEvent,
  type MonthlyScheduleContext,
  type MonthlySchedule,
  type IncidentDesignContext,
  type IncidentDesign,
  type RuleProposalContext,
  type BehaviorRule,
  type DistillContext,
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

/**
 * 世界イベント提案/ルール化は codex の fast service tier を使う。
 * Codex CLI 側の service_tier=fast 設定を前提に、read-only exec で JSON だけを返させる。
 */
const CODEX_FAST_WORLD_BACKEND: Backend = { id: 'codex-fast-world', provider: 'codex', model: 'gpt-5.5' };

export interface LlmWorldBrainOptions {
  createClient?: (backend: Backend) => LlmClient;
  timeoutMs?: number;
  /** CLI の一過性失敗リトライ回数 (PagusConfig.llm.cliRetries)。 */
  retries?: number;
  /** LLM 呼び出しごとのコスト計上フック (§7)。未指定なら計上しない。 */
  costSink?: CostSink;
  /** LLM が止まった時に使う代替 WorldBrain。既定は StubWorldBrain。 */
  fallback?: WorldBrain;
  /** 失敗した backend を即時スキップする時間。 */
  offlineCooldownMs?: number;
}

const DEFAULT_WORLD_TIMEOUT_MS = 30_000;
const DEFAULT_OFFLINE_COOLDOWN_MS = 120_000;

export class LlmWorldBrain implements WorldBrain {
  private readonly registry: BackendRegistry;
  private readonly createClient: (backend: Backend) => LlmClient;
  private readonly clients = new Map<string, LlmClient>();
  private readonly costSink: CostSink | undefined;
  private readonly fallback: WorldBrain;
  private readonly offlineCooldownMs: number;
  private readonly offlineUntil = new Map<string, number>();

  constructor(registry: BackendRegistry, opts: LlmWorldBrainOptions = {}) {
    this.registry = registry;
    this.costSink = opts.costSink;
    this.fallback = opts.fallback ?? new StubWorldBrain();
    this.offlineCooldownMs = opts.offlineCooldownMs ?? DEFAULT_OFFLINE_COOLDOWN_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WORLD_TIMEOUT_MS;
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
    return this.withFallback(
      backend,
      parts,
      async () => {
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
      },
      () => this.fallback.evaluateDay(ctx),
    );
  }

  async holidayEvent(ctx: HolidayContext): Promise<HolidayEvent> {
    const parts = buildHolidayPrompt(ctx);
    // 祝日名を決定的キーに strong tier を選ぶ (年に数回、軽い局面)。
    const backend = this.registry.strong(`holiday:${ctx.holiday}:${ctx.calendar.year}`);
    return this.withFallback(
      backend,
      parts,
      async () => {
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
      },
      () => this.fallback.holidayEvent(ctx),
    );
  }

  async scheduleMonthlyIncident(ctx: MonthlyScheduleContext): Promise<MonthlySchedule> {
    const parts = buildSchedulePrompt(ctx);
    // 月初の発生日/テーマ提案は codex fast のブラックボックス世界エンジンへ寄せる。
    const backend = CODEX_FAST_WORLD_BACKEND;
    return this.withFallback(
      backend,
      parts,
      async () => {
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
      },
      () => this.fallback.scheduleMonthlyIncident(ctx),
    );
  }

  async designIncident(ctx: IncidentDesignContext): Promise<IncidentDesign> {
    const parts = buildDesignPrompt(ctx);
    // 事件の詳細デザインも codex fast に寄せ、マーダーミステリー/人狼風の提案を軽く回す。
    const backend = CODEX_FAST_WORLD_BACKEND;
    return this.withFallback(
      backend,
      parts,
      async () => {
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
      },
      () => this.fallback.designIncident(ctx),
    );
  }

  async proposeRule(ctx: RuleProposalContext): Promise<BehaviorRule> {
    const parts = buildRulePrompt(ctx);
    // ルール起案はイベント提案と同じ codex fast で、事件テーマを日常ルールへ落とす。
    const backend = CODEX_FAST_WORLD_BACKEND;
    return this.withFallback(
      backend,
      parts,
      async () => {
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
      },
      () => this.fallback.proposeRule(ctx),
    );
  }

  private backendOffline(backend: Backend): boolean {
    return Date.now() < (this.offlineUntil.get(backend.id) ?? 0);
  }

  private markBackendOffline(backend: Backend, parts: PromptParts, err: unknown): void {
    this.offlineUntil.set(backend.id, Date.now() + this.offlineCooldownMs);
    console.warn(
      `[pagus] world LLM fallback (${parts.kind}, backend=${backend.id}): ${(err as Error).message}`,
    );
  }

  private async withFallback<T>(
    backend: Backend,
    parts: PromptParts,
    run: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    if (this.backendOffline(backend)) return fallback();
    try {
      return await run();
    } catch (e) {
      this.markBackendOffline(backend, parts, e);
      return fallback();
    }
  }

  /** 乖離ケースを説明するルールを蒸留する (§v1.4-C)。世界エンジン同様 codex fast を使う。 */
  async distillRule(ctx: DistillContext): Promise<BehaviorRule> {
    const parts = buildDistillPrompt(ctx);
    const backend = CODEX_FAST_WORLD_BACKEND;
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
