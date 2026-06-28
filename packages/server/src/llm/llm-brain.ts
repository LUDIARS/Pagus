// 実 LLM 駆動の Brain 実装。
//
// 各メソッドで backend (provider+model) を選び、CLI クライアントで invoke → JSON parse →
// sim 型で返す。tier ルーティング (routeTier) で軽い局面は per-villager 割当、重い局面
// (承GANs/裁判/教育) は strong (opus/gpt-5.5) へ寄せる。
// parse 失敗は 1 回リトライ→なお失敗なら throw (無言フォールバック禁止)。

import type {
  Brain,
  EmotionContext,
  ActionContext,
  ActionDecision,
  IncidentContext,
  IncidentStep,
  FoolishVoteContext,
  FateVoteContext,
  EducationContext,
  EmotionState,
  VillagerId,
  Reform,
} from '@pagus/sim';

import { estimateTokens } from '@ludiars/llm-gateway';

import type { LlmClient } from './llm-client.js';
import { CliLlmClient, type CliLlmClientOptions } from './cli-llm-client.js';
import { BackendRegistry } from './backend-registry.js';
import type { Backend } from './backend-registry.js';
import type { CostSink } from './cost-log.js';
import {
  buildEmotionPrompt,
  buildActionPrompt,
  buildIncidentPrompt,
  buildFoolishPrompt,
  buildFatePrompt,
  buildEducationPrompt,
  routeTier,
  type PromptParts,
} from './prompt-build.js';
import {
  extractJson,
  coerceEmotion,
  coerceAction,
  coerceIncidentStep,
  coerceFoolishPick,
  coerceFate,
  coerceReform,
} from './json-coerce.js';

export interface LlmBrainOptions {
  /** backend → LlmClient のファクトリ (test 差し替え用)。既定は CLI クライアント。 */
  createClient?: (backend: Backend) => LlmClient;
  /** invoke タイムアウト ms。 */
  timeoutMs?: number;
  /** CLI の一過性失敗リトライ回数 (PagusConfig.llm.cliRetries)。 */
  retries?: number;
  /** LLM 呼び出しごとのコスト計上フック (§7)。未指定なら計上しない。 */
  costSink?: CostSink;
}

export class LlmBrain implements Brain {
  private readonly registry: BackendRegistry;
  private readonly createClient: (backend: Backend) => LlmClient;
  private readonly clients = new Map<string, LlmClient>();
  private readonly costSink: CostSink | undefined;
  /** プレイヤー扇動: 次の自由行動で事件化を促す。 */
  private incitePending = false;

  constructor(registry: BackendRegistry, opts: LlmBrainOptions = {}) {
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

  /** プレイヤーの扇動 (TermLoop.incite から呼ばれる)。次の自由行動で事件化を促す。 */
  forceNext(): void {
    this.incitePending = true;
  }

  async updateEmotion(ctx: EmotionContext): Promise<EmotionState> {
    const parts = buildEmotionPrompt(ctx);
    const backend = this.select(parts, ctx.villager.id, ctx.villager.id);
    return this.invokeJson(backend, parts, coerceEmotion);
  }

  async decideAction(ctx: ActionContext): Promise<ActionDecision> {
    const incited = this.incitePending && ctx.directive === null;
    const parts = buildActionPrompt(ctx, incited);
    const backend = this.select(parts, ctx.villager.id, ctx.villager.id);
    const decision = await this.invokeJson(backend, parts, coerceAction);
    if (incited) this.incitePending = false;
    return decision;
  }

  async advanceIncident(ctx: IncidentContext): Promise<IncidentStep> {
    const parts = buildIncidentPrompt(ctx);
    const backend = this.select(parts, ctx.perpetrator.id, ctx.perpetrator.id);
    return this.invokeJson(backend, parts, coerceIncidentStep);
  }

  async groupVoteFoolish(ctx: FoolishVoteContext): Promise<VillagerId> {
    const parts = buildFoolishPrompt(ctx);
    const backend = this.select(parts, ctx.axis, ctx.axis);
    const allowed = new Set<VillagerId>(ctx.candidates.map((c) => c.id));
    return this.invokeJson(backend, parts, (u) => coerceFoolishPick(u, allowed));
  }

  async groupVoteFate(ctx: FateVoteContext): Promise<'kill' | 'spare'> {
    const parts = buildFatePrompt(ctx);
    const backend = this.select(parts, ctx.axis, ctx.axis);
    return this.invokeJson(backend, parts, coerceFate);
  }

  async decideEducation(ctx: EducationContext): Promise<Reform> {
    const parts = buildEducationPrompt(ctx);
    const backend = this.select(parts, ctx.perpetrator.id, ctx.perpetrator.id);
    return this.invokeJson(backend, parts, (u) => coerceReform(u, ctx.perpetrator.id));
  }

  // --- 内部 ---------------------------------------------------------------

  /** tier に応じて backend を選ぶ。cheap=per-villager 割当 / strong=strong tier。 */
  private select(parts: PromptParts, lightKey: string, strongKey: string): Backend {
    return routeTier(parts) === 'strong'
      ? this.registry.strong(strongKey)
      : this.registry.assign(lightKey);
  }

  private clientFor(backend: Backend): LlmClient {
    let c = this.clients.get(backend.id);
    if (!c) {
      c = this.createClient(backend);
      this.clients.set(backend.id, c);
    }
    return c;
  }

  /**
   * invoke → JSON 抽出 → validate。validate 失敗は 1 回だけ再 invoke、なお失敗で throw。
   * CLI 自体のエラー (spawn/timeout/非ゼロ終了) は即 throw (リトライしない)。
   */
  private async invokeJson<T>(
    backend: Backend,
    parts: PromptParts,
    validate: (u: unknown) => T,
  ): Promise<T> {
    const client = this.clientFor(backend);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await client.invoke({
        system: parts.system,
        prompt: parts.prompt,
        model: backend.model,
      });
      // 成功した invoke ごとにコスト計上 (parse 成否に関わらず CLI 呼び出しは発生済)。
      this.costSink?.({
        kind: parts.kind,
        provider: backend.provider,
        model: backend.model,
        inTokens: estimateTokens(parts.system) + estimateTokens(parts.prompt),
        outTokens: estimateTokens(text),
      });
      try {
        return validate(extractJson(text));
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(
      `LLM 応答の parse に失敗 (${parts.kind}, backend=${backend.id}): ${(lastErr as Error).message}`,
    );
  }
}
