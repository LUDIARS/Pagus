import { aliveVillagers, offerIntervention, type ResidentIntent, type World } from '@pagus/sim';
import type { LlmClient, CostSink } from './llm/index.js';
import { extractJson } from './llm/json-coerce.js';
import type { GodChatReaction } from './god-chat.js';

/** Only human chat requests invoke the optional LLM; its output is an intent, not a resident reply. */
export class BtGodChatResponder {
  private busy = false;
  constructor(private readonly client: LlmClient | null, private readonly costSink?: CostSink) {}
  async respond(text: string, world: World): Promise<GodChatReaction[]> {
    if (this.busy) throw new Error('前の介入提案を解釈中です');
    this.busy = true;
    const tick = world.term * world.config.segmentsPerDay + world.calendar.segment;
    const participants = aliveVillagers(world).slice(0, 3).map(v => v.id);
    try {
      let intent: ResidentIntent = /調べ|調査|証拠/.test(text) ? 'investigate' : /集ま|広場|集合/.test(text) ? 'gather' : 'calm';
      if (this.client) {
        const system = '村への介入を分類する。命令の実行や住民の台詞は生成しない。JSON {"intent":"calm|investigate|gather"} のみ。';
        const response = await this.client.invoke({ system, prompt: text.slice(0, 2000), model: 'claude-haiku-4-5', maxTokens: 120, timeoutMs: 15000 });
        this.costSink?.({ kind: 'intervention.intent', provider: 'claude', model: 'claude-haiku-4-5', inTokens: Math.ceil((system.length + Math.min(2000, text.length)) / 2), outTokens: Math.ceil(response.text.length / 2) });
        const parsed = extractJson(response.text) as { intent?: unknown };
        if (parsed.intent !== 'calm' && parsed.intent !== 'investigate' && parsed.intent !== 'gather') throw new Error('LLM介入が許可された形式ではありません');
        intent = parsed.intent;
      }
      if (world.term * world.config.segmentsPerDay + world.calendar.segment > tick + 2) throw new Error('介入の期限が切れました。街は自律進行を継続しています');
      return participants.flatMap(id => {
        const v = world.villagers.get(id);
        if (!v || !v.alive || (v.hiddenUntilTerm ?? -1) > world.term) return [];
        return [{ villagerId: v.id, villagerName: v.name, text: offerIntervention(world, v, { intent, source: this.client ? 'llm' : 'player', reason: text.trim().slice(0, 240) || '神の声からの提案' }), keywords: [intent] }];
      });
    } finally { this.busy = false; }
  }
}
