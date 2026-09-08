// 裁判の糾弾セリフを用意する。各糾弾者につき:
//   65% (genProbability) → Haiku が被告の事件を踏まえて新規生成し、レパートリーへ保存。
//   35% → 既存レパートリーから再利用。
// 生成は並行 (Promise.all)。LLM 不在 (stub) のときは全て再利用。

import { pickTrialAttendees, visibleStoryEvidence, type World, type Villager, type TrialLine } from '@pagus/sim';
import type { LlmClient } from './llm/llm-client.js';
import { extractJson } from './llm/json-coerce.js';
import { Repertoire, type RepertoireOptions } from './repertoire.js';
import { residentSpeech } from '@pagus/sim';

const HAIKU_MODEL = 'claude-haiku-4-5';

export interface TrialNarratorOptions {
  residentBt?: boolean;
  /** Haiku 生成に使う client (省略時は再利用のみ)。 */
  client?: LlmClient;
  /** 新規生成する割合 (0..1)。既定 0.65。 */
  genProbability?: number;
  /** テーマパックのトーン指示 (§v1.4-D)。生成プロンプトに足す。 */
  tone?: string;
  /** レパートリーの永続ファイル/種 (§v1.4-D、パックごとに分ける)。 */
  repertoire?: RepertoireOptions;
}

export class TrialNarrator {
  private readonly repertoire: Repertoire;
  private readonly client: LlmClient | undefined;
  private readonly genProb: number;
  private readonly tone: string;
  private readonly residentBt: boolean;

  constructor(opts: TrialNarratorOptions = {}) {
    this.residentBt = opts.residentBt ?? false;
    this.repertoire = new Repertoire(opts.repertoire ?? {});
    this.client = opts.client;
    this.genProb = opts.genProbability ?? 0.65;
    this.tone = opts.tone ?? '';
  }

  /** ログ用: 現在のプール件数。 */
  get poolSize(): number {
    return this.repertoire.size;
  }

  /** その事件の被告へ向けた、糾弾者ごとの一言を作る。 */
  async linesFor(world: World): Promise<TrialLine[]> {
    if (world.trial?.factions) return world.trial.factions.lines.slice(-4).map(line => ({ speaker: line.speaker, text: line.text }));
    const incident = world.incident;
    if (!incident) return [];
    const target = world.villagers.get(world.trial?.defendant ?? incident.perpetrator);
    if (!target) return [];
    const accusers = pickTrialAttendees([...world.villagers.values()], target.id, incident.id);
    if (this.residentBt) return accusers.map(v => ({ speaker: v.id, text: residentSpeech(v, world, 'trial') }));
    if (incident.story) {
      const records = visibleStoryEvidence(incident, world.trial?.stage);
      return accusers.map((accuser, index) => ({ speaker: accuser.id,
        text: index % 2 === 0 ? `${records[index % Math.max(1, records.length)]?.title ?? '証言'}を確かめたい。${incident.story?.question}`
          : `その記録だけで${target.name}を断定していいの？`,
      }));
    }

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
      (this.tone ? `トーン: ${this.tone}` : '') +
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
