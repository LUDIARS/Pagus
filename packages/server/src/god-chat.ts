// 神の声チャット用の住民リアクション。
// Haiku で短い形態素/意図解析を行い、ローカルのブラックボックス規則で返答を選ぶ。
// 未知の話題は Haiku 生成結果を data/runtime/god-chat-blackbox.json に学習する。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Villager, World } from '@pagus/sim';
import type { CostSink, LlmClient } from './llm/index.js';
import { extractJson } from './llm/json-coerce.js';
import { dataDir } from './load-data.js';

export interface GodChatReaction {
  villagerId: string;
  villagerName: string;
  text: string;
  keywords: string[];
}

interface Analysis {
  keywords: string[];
  topic: string;
  tone: string;
}

interface LearnedRule {
  id: string;
  keywords: string[];
  templates: string[];
  createdAt: number;
  hits: number;
}

interface GodChatResponderOptions {
  client: LlmClient;
  costSink?: CostSink;
  rng?: () => number;
}

const MODEL = 'claude-haiku-4-5';
const RULE_CAP = 80;

const DEFAULT_RULES: readonly LearnedRule[] = [
  {
    id: 'trial',
    keywords: ['裁判', '死刑', '教育', '判決'],
    templates: [
      '{name} は「裁きは急がず、言い分を聞いた方がいい」と言った。',
      '{name} は「死刑か教育か、村の空気が重くなるな」とつぶやいた。',
      '{name} は「証拠がない裁きは、あとで火種になる」と首をかしげた。',
    ],
    createdAt: 0,
    hits: 0,
  },
  {
    id: 'rule',
    keywords: ['しきたり', '掟', 'ルール', '法'],
    templates: [
      '{name} は「新しいしきたりは、守れる形でないと続かない」と答えた。',
      '{name} は「その掟、誰が得をするのか気になる」と目を細めた。',
      '{name} は「村の決まりなら、抜け道も見ておきたい」と言った。',
    ],
    createdAt: 0,
    hits: 0,
  },
  {
    id: 'incident',
    keywords: ['事件', '犯人', '噂', '怪しい', '証拠'],
    templates: [
      '{name} は「その噂、誰が最初に言ったのかが大事だ」と返した。',
      '{name} は「怪しいだけで決めると、本当の火元を見逃す」と言った。',
      '{name} は「証拠があるなら、今夜の動きと合わせて見たい」と身を乗り出した。',
    ],
    createdAt: 0,
    hits: 0,
  },
  {
    id: 'money',
    keywords: ['金', '経済', 'カルマ', '買う', '売る', '保険'],
    templates: [
      '{name} は「金の流れを見ると、村の本音が見える」と言った。',
      '{name} は「保険をかけるなら、誰を守りたいかを先に決めたい」と考え込んだ。',
      '{name} は「カルマは便利だが、頼りすぎると足元をすくわれる」と返した。',
    ],
    createdAt: 0,
    hits: 0,
  },
  {
    id: 'daily',
    keywords: ['仕事', '暮らし', '生活', '朝', '夜', '寝る'],
    templates: [
      '{name} は「毎日の動きにこそ、その人の癖が出る」とうなずいた。',
      '{name} は「夜は休まないと、翌日の村が荒れる」と静かに言った。',
      '{name} は「暮らしの小さなズレが、事件の芽になることもある」と答えた。',
    ],
    createdAt: 0,
    hits: 0,
  },
];

export class GodChatResponder {
  private readonly rng: () => number;
  private readonly box: GodChatBlackBox;

  constructor(private readonly opts: GodChatResponderOptions) {
    this.rng = opts.rng ?? Math.random;
    this.box = new GodChatBlackBox();
  }

  async respond(text: string, world: World): Promise<GodChatReaction[]> {
    const villagers = [...world.villagers.values()].filter((v) => v.alive);
    if (villagers.length === 0) return [];
    const analysis = await this.analyze(text);
    const picked = pickSome(villagers, this.rng, Math.min(3, villagers.length));
    const fromBox = this.box.reply(text, analysis.keywords, picked, this.rng);
    if (fromBox.length > 0) return fromBox;

    const generated = await this.generate(text, analysis, picked);
    if (generated.length > 0) {
      this.box.learn(analysis.keywords, generated.map((r) => r.text));
      return generated;
    }
    return fallbackReplies(text, analysis.keywords, picked, this.rng);
  }

  private async analyze(text: string): Promise<Analysis> {
    const local = localAnalysis(text);
    const system = 'あなたは日本語の短文を形態素的に粗く分析する。JSON 以外を返さない。';
    const prompt =
      '次の発言を、AI村シミュレーション用に短く分析してください。\n' +
      '出力 JSON: {"keywords":["名詞または重要語を最大6個"],"topic":"一語","tone":"一語"}\n' +
      `発言: ${text}`;
    try {
      const res = await this.opts.client.invoke({ system, prompt, model: MODEL, maxTokens: 300, timeoutMs: 45_000 });
      this.recordCost('chat.analysis', system + prompt, res.text);
      const parsed = extractJson(res.text) as Partial<Analysis>;
      const keywords = normalizeKeywords(parsed.keywords).slice(0, 6);
      return {
        keywords: mergeKeywords(keywords, local.keywords).slice(0, 8),
        topic: typeof parsed.topic === 'string' && parsed.topic.trim() ? parsed.topic.trim().slice(0, 20) : local.topic,
        tone: typeof parsed.tone === 'string' && parsed.tone.trim() ? parsed.tone.trim().slice(0, 20) : local.tone,
      };
    } catch {
      return local;
    }
  }

  private async generate(text: string, analysis: Analysis, villagers: Villager[]): Promise<GodChatReaction[]> {
    const roster = villagers
      .map((v) => `${v.id}: ${v.name} / ${v.species} / 趣味=${v.hobby} / 口調=${v.persona.speechStyle} / 価値観=${v.persona.values.join('、')}`)
      .join('\n');
    const system = 'あなたはAI村の住民反応を書く。安全で短い日本語の JSON だけを返す。';
    const prompt =
      '神の声チャットへの住民反応を作る。\n' +
      '条件: 住民ごとに1文、最大60字、発言内容に乗るか少し疑う。過激な性的表現は禁止。\n' +
      '出力 JSON: {"replies":[{"villagerId":"候補id","text":"返答"}],"templates":["再利用できる返答文"]}\n' +
      `発言: ${text}\n` +
      `分析語: ${analysis.keywords.join(', ')} / topic=${analysis.topic} / tone=${analysis.tone}\n` +
      `候補住民:\n${roster}`;
    try {
      const res = await this.opts.client.invoke({ system, prompt, model: MODEL, maxTokens: 700, timeoutMs: 60_000 });
      this.recordCost('chat.reply', system + prompt, res.text);
      const obj = extractJson(res.text) as { replies?: unknown };
      if (!Array.isArray(obj.replies)) return [];
      const byId = new Map(villagers.map((v) => [v.id, v]));
      const out: GodChatReaction[] = [];
      for (const raw of obj.replies) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as { villagerId?: unknown; text?: unknown };
        if (typeof r.villagerId !== 'string' || typeof r.text !== 'string') continue;
        const villager = byId.get(r.villagerId);
        if (!villager) continue;
        const reply = sanitizeReply(r.text);
        if (!reply) continue;
        out.push({ villagerId: villager.id, villagerName: villager.name, text: reply, keywords: analysis.keywords });
      }
      return out.slice(0, 3);
    } catch {
      return [];
    }
  }

  private recordCost(kind: string, input: string, output: string): void {
    this.opts.costSink?.({
      kind,
      provider: 'claude',
      model: MODEL,
      inTokens: estimateTokens(input),
      outTokens: estimateTokens(output),
    });
  }
}

class GodChatBlackBox {
  private readonly path: string;
  private rules: LearnedRule[];

  constructor() {
    this.path = resolve(dataDir(), 'runtime', 'god-chat-blackbox.json');
    this.rules = [...DEFAULT_RULES.map((r) => ({ ...r, keywords: [...r.keywords], templates: [...r.templates] })), ...this.load()];
  }

  reply(text: string, keywords: readonly string[], villagers: readonly Villager[], rng: () => number): GodChatReaction[] {
    const rule = this.pickRule(text, keywords, rng);
    if (!rule) return [];
    rule.hits += 1;
    if (rule.createdAt > 0) this.saveLearned();
    return villagers.map((v) => ({
      villagerId: v.id,
      villagerName: v.name,
      text: fillTemplate(rule.templates[Math.floor(rng() * rule.templates.length)] ?? '{name} は黙って考え込んだ。', v),
      keywords: [...new Set([...keywords, ...rule.keywords])].slice(0, 8),
    }));
  }

  learn(keywords: readonly string[], replies: readonly string[]): void {
    const normalized = normalizeKeywords(keywords).slice(0, 6);
    const templates = replies.map(toTemplate).map(sanitizeReply).filter((s): s is string => s !== null && s.length > 0).slice(0, 6);
    if (normalized.length === 0 || templates.length === 0) return;
    this.rules.push({
      id: `learned-${Date.now().toString(36)}`,
      keywords: normalized,
      templates,
      createdAt: Date.now(),
      hits: 0,
    });
    const learned = this.rules.filter((r) => r.createdAt > 0);
    if (learned.length > RULE_CAP) {
      const drop = learned.length - RULE_CAP;
      let removed = 0;
      this.rules = this.rules.filter((r) => {
        if (r.createdAt === 0) return true;
        if (removed < drop) {
          removed += 1;
          return false;
        }
        return true;
      });
    }
    this.saveLearned();
  }

  private pickRule(text: string, keywords: readonly string[], rng: () => number): LearnedRule | null {
    const haystack = `${text} ${keywords.join(' ')}`;
    const scored = this.rules
      .map((rule) => ({
        rule,
        score: rule.keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 1 : 0), 0),
      }))
      .filter((x) => x.score > 0);
    if (scored.length === 0) return null;
    const max = Math.max(...scored.map((x) => x.score));
    const top = scored.filter((x) => x.score === max);
    return top[Math.floor(rng() * top.length)]?.rule ?? null;
  }

  private load(): LearnedRule[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.map(coerceRule).filter((r): r is LearnedRule => r !== null).slice(-RULE_CAP);
    } catch {
      return [];
    }
  }

  private saveLearned(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.rules.filter((r) => r.createdAt > 0), null, 2), 'utf8');
    } catch {
      /* 学習保存失敗はゲーム進行を止めない */
    }
  }
}

function localAnalysis(text: string): Analysis {
  const keywords = normalizeKeywords([
    ...keywordIf(text, ['裁判', '死刑', '教育', '判決']),
    ...keywordIf(text, ['しきたり', '掟', 'ルール', '法']),
    ...keywordIf(text, ['事件', '犯人', '噂', '怪しい', '証拠']),
    ...keywordIf(text, ['金', '経済', 'カルマ', '買う', '売る', '保険']),
    ...keywordIf(text, ['仕事', '暮らし', '生活', '朝', '夜', '寝る']),
    ...text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2).slice(0, 4),
  ]);
  return {
    keywords: keywords.slice(0, 8),
    topic: keywords[0] ?? '雑談',
    tone: /怖|不安|嫌|殺|死/.test(text) ? '不穏' : /好き|良|助|守/.test(text) ? '好意' : '中立',
  };
}

function keywordIf(text: string, words: readonly string[]): string[] {
  return words.filter((w) => text.includes(w));
}

function normalizeKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map((x) => x.slice(0, 20)))];
}

function mergeKeywords(primary: readonly string[], fallback: readonly string[]): string[] {
  return [...new Set([...primary, ...fallback])];
}

function pickSome(villagers: Villager[], rng: () => number, max: number): Villager[] {
  const shuffled = [...villagers].sort(() => rng() - 0.5);
  const count = Math.max(1, Math.min(max, 1 + Math.floor(rng() * max)));
  return shuffled.slice(0, count);
}

function fallbackReplies(text: string, keywords: readonly string[], villagers: readonly Villager[], rng: () => number): GodChatReaction[] {
  const templates = localAnalysis(text).keywords.length > 0
    ? ['{name} は「その話、少し気になる」と答えた。', '{name} は「村のみんなにも聞いてみたい」と言った。']
    : ['{name} は神の声を聞き、しばらく考え込んだ。'];
  return villagers.map((v) => ({
    villagerId: v.id,
    villagerName: v.name,
    text: fillTemplate(templates[Math.floor(rng() * templates.length)] ?? templates[0] ?? '{name} は黙った。', v),
    keywords: [...keywords],
  }));
}

function fillTemplate(template: string, villager: Villager): string {
  return sanitizeReply(template.replaceAll('{name}', villager.name)) ?? `${villager.name} は黙って考え込んだ。`;
}

function sanitizeReply(text: string): string | null {
  const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, 90);
  return cleaned.length > 0 ? cleaned : null;
}

function toTemplate(text: string): string {
  const match = text.match(/^([^ は「]+)(.*)$/);
  return match ? `{name}${match[2] ?? ''}` : text;
}

function coerceRule(raw: unknown): LearnedRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<LearnedRule>;
  const keywords = normalizeKeywords(obj.keywords).slice(0, 6);
  const templates = Array.isArray(obj.templates)
    ? obj.templates.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 8)
    : [];
  if (keywords.length === 0 || templates.length === 0) return null;
  return {
    id: typeof obj.id === 'string' ? obj.id : `learned-${Date.now().toString(36)}`,
    keywords,
    templates,
    createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
    hits: typeof obj.hits === 'number' ? obj.hits : 0,
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3));
}
