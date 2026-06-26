// 裁判の糾弾セリフを用意する。各糾弾者につき:
//   65% (genProbability) → Haiku が被告の事件を踏まえて新規生成し、レパートリーへ保存。
//   35% → 既存レパートリーから再利用。
// 生成は並行 (Promise.all)。LLM 不在 (stub) のときは全て再利用。

import type { World, Villager, TrialLine } from '@pagus/sim';
import type { LlmClient } from './llm/llm-client.js';
import { extractJson } from './llm/json-coerce.js';
import { Repertoire } from './repertoire.js';

const HAIKU_MODEL = 'claude-haiku-4-5';

export interface TrialNarratorOptions {
  /** Haiku 生成に使う client (省略時は再利用のみ)。 */
  client?: LlmClient;
  /** 新規生成する割合 (0..1)。既定 0.65。 */
  genProbability?: number;
}

export class TrialNarrator {
  private readonly repertoire = new Repertoire();
  private readonly client: LlmClient | undefined;
  private readonly genProb: number;

  constructor(opts: TrialNarratorOptions = {}) {
    this.client = opts.client;
    this.genProb = opts.genProbability ?? 0.65;
  }

  /** ログ用: 現在のプール件数。 */
  get poolSize(): number {
    return this.repertoire.size;
  }

  /** その事件の被告へ向けた、糾弾者ごとの一言を作る。 */
  async linesFor(world: World): Promise<TrialLine[]> {
    const incident = world.incident;
    if (!incident) return [];
    const target = world.villagers.get(incident.perpetrator);
    if (!target) return [];
    const accusers = [...world.villagers.values()].filter((v) => v.alive && v.id !== target.id);

    return Promise.all(
      accusers.map(async (accuser) => ({
        speaker: accuser.id,
        text: await this.lineFor(accuser, target, incident.description),
      })),
    );
  }

  private async lineFor(accuser: Villager, target: Villager, incidentDesc: string): Promise<string> {
    if (this.client && Math.random() < this.genProb) {
      try {
        const text = await this.generate(accuser, target, incidentDesc);
        this.repertoire.add(text);
        return text;
      } catch {
        // 生成失敗は再利用にフォールバック (無言フォールバックではなく機能縮退)。
        return this.repertoire.pick();
      }
    }
    return this.repertoire.pick();
  }

  private async generate(accuser: Villager, target: Villager, incidentDesc: string): Promise<string> {
    const system =
      'あなたは村の住民。裁判で被告を糾弾する短い一言を作る。8〜20文字、感情的・口語、日本語。' +
      'JSON オブジェクトだけを返す: {"line":"..."}。説明文・コードフェンスは付けない。';
    const prompt =
      `被告: ${target.name}(${target.species})\n` +
      `事件: ${incidentDesc}\n` +
      `あなたは「${accuser.name}」(性格 攻撃性=${accuser.persona.traits.aggression.toFixed(1)})。` +
      'この被告へ投げる短い糾弾を 1 つ、JSON で返せ。';
    const { text } = await this.client!.invoke({ system, prompt, model: HAIKU_MODEL });
    const obj = extractJson(text) as { line?: unknown };
    const line = typeof obj.line === 'string' ? obj.line.trim() : '';
    if (line.length === 0) throw new Error('Haiku 糾弾生成: line が空');
    return line;
  }
}
