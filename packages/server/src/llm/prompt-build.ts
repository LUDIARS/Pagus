// 各 Brain / WorldBrain メソッドのプロンプト組み立て。
//
// `@ludiars/llm-gateway` の orderSegments (prefix-cache 整形) / pickTier (tier ルーティング)
// / estimateTokens (概算トークン) を使う。固定指示 (出力規約) は fixed 断片、文脈は volatile
// 断片に置き、不変プレフィックスを前に寄せてキャッシュヒット率を上げる。
//
// 各プロンプトは「JSON だけで返せ」と指示し、返り値スキーマを sim 型に一致させる。

import { orderSegments, pickTier, estimateTokens } from '@ludiars/llm-gateway';
import type { Segment, Tier } from '@ludiars/llm-gateway';

import {
  PERSONALITY_AXES,
  PERSONALITY_LABELS,
  VIRTUES,
  VIRTUE_LABELS,
} from '@pagus/sim';
import type {
  EmotionContext,
  ActionContext,
  IncidentContext,
  FoolishVoteContext,
  FateVoteContext,
  EducationContext,
  WorldEvalContext,
  HolidayContext,
  Villager,
  Personality,
} from '@pagus/sim';

/** 組み上げたプロンプト。kind は tier ルーティングに使う。 */
export interface PromptParts {
  /** タスク種別 (例: 'emotion' | 'incident' | 'world')。 */
  kind: string;
  system: string;
  prompt: string;
}

/** 重い局面は無条件で strong、入力が大きいときも strong へ寄せる。 */
const ROUTING_RULES = {
  strongKinds: ['incident', 'foolish', 'fate', 'education', 'world'],
  strongAboveTokens: 6000,
};

/** prompt 内容から cheap/strong を決める (pickTier + estimateTokens)。 */
export function routeTier(parts: PromptParts): Tier {
  const inputTokens = estimateTokens(parts.system) + estimateTokens(parts.prompt);
  return pickTier({ kind: parts.kind, inputTokens }, ROUTING_RULES);
}

// --- 共通シリアライザ -------------------------------------------------------

function traitsLine(p: Personality): string {
  return PERSONALITY_AXES.map((ax) => `${PERSONALITY_LABELS[ax]}=${p[ax].toFixed(2)}`).join(' ');
}

function villagerBrief(v: Villager): string {
  const e = Object.entries(v.emotion.axes)
    .map(([k, n]) => `${k}:${n.toFixed(2)}`)
    .join(' ');
  return [
    `${v.name} (${v.species}, id=${v.id})`,
    `性格: ${traitsLine(v.persona.traits)}`,
    `信条: ${v.persona.values.join(' / ') || 'なし'}`,
    `口調: ${v.persona.speechStyle}`,
    `姿: ${v.appearance.body} [${v.appearance.descriptors.join(',')}]`,
    `感情: ${v.emotion.label}${e ? ` (${e})` : ''}`,
  ].join('\n');
}

/** 断片を安定度順に整列し、system/user 文字列へ畳む。 */
function partsFromSegments(kind: string, segments: Segment[]): PromptParts {
  const ordered = orderSegments(segments);
  const system = ordered.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const prompt = ordered.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n\n');
  return { kind, system, prompt };
}

const JSON_ONLY = 'JSON オブジェクトだけを返すこと。前後に説明文・コードフェンスを付けない。';

// --- 感情の初期化/更新 ------------------------------------------------------

export function buildEmotionPrompt(ctx: EmotionContext): PromptParts {
  const sys =
    'あなたは村シミュレーションの「感情エンジン」。1 体のどうぶつの感情を更新する。\n' +
    `出力スキーマ: {"axes": {"<軸名>": -1..1 の数値, ...}, "label": "現在の気分(短い日本語)"}\n` +
    '軸は joy / anger / fear / sadness など自由。値域は -1..1。' +
    JSON_ONLY;
  const env = ctx.environment;
  const user =
    `${villagerBrief(ctx.villager)}\n` +
    `場所: ${env.place} / 時間帯: ${env.timeOfDay}\n` +
    `周囲: ${env.nearby.map((n) => n.name).join(', ') || 'いない'}\n` +
    `直近の出来事: ${ctx.recentEvents.join(' / ') || 'なし'}\n` +
    'この状況を踏まえ、更新後の感情を JSON で返せ。';
  return partsFromSegments('emotion', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}

// --- 起: 行動決定 -----------------------------------------------------------

export function buildActionPrompt(ctx: ActionContext, incited: boolean): PromptParts {
  const sys =
    'あなたは村シミュレーションの「行動エンジン」。1 体のどうぶつの 1 手を決める。\n' +
    '出力スキーマ: {"move": {"x": 整数, "y": 整数} | null, "action": "とった行動(日本語)", ' +
    '"newEmotion": {"axes": {"<軸>": -1..1}, "label": "気分"}, ' +
    '"triggersIncident": true|false, ' +
    '"incidentSeed": {"description": "事件の概要", "involved": ["villagerId", ...]} | null}\n' +
    'triggersIncident=false のとき incidentSeed は必ず null。' +
    JSON_ONLY;
  const env = ctx.environment;
  const d = ctx.directive;
  const directiveLine = d
    ? `差配イベント: category=${d.category} actor=${d.actor} target=${d.target ?? 'なし'}\n` +
      '(このイベントを行動として narration する。harass かつ target ありなら事件化する)'
    : '差配イベント: なし (自由行動)';
  const inciteLine = incited
    ? '\n【プレイヤーが扇動した】可能なら周囲を巻き込む事件を起こす行動を選べ。'
    : '';
  const user =
    `${villagerBrief(ctx.villager)}\n` +
    `現在地: (${ctx.villager.position.x},${ctx.villager.position.y}) / 場所: ${env.place} / 時間帯: ${env.timeOfDay}\n` +
    `周囲: ${env.nearby.map((n) => `${n.name}(${n.id})`).join(', ') || 'いない'}\n` +
    `${directiveLine}${inciteLine}\n` +
    '1 手を JSON で返せ。';
  return partsFromSegments('action', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}

// --- 承: 事件 (GANs) 進行 ---------------------------------------------------

export function buildIncidentPrompt(ctx: IncidentContext): PromptParts {
  const sys =
    'あなたは村シミュレーションの「事件エンジン」。加害者と被害者が応酬する事件を 1 ステップ進める。\n' +
    '出力スキーマ: {"action": "その視点でとられた行動(日本語)", "damageDelta": 0以上の数値, "ended": true|false}\n' +
    'damageDelta は被害の増分。ended=true で事件を打ち切れる。' +
    JSON_ONLY;
  const inc = ctx.incident;
  const log = inc.steps
    .slice(-4)
    .map((s) => `- [${s.perspective}] ${s.action} (+${s.damageDelta})`)
    .join('\n');
  const user =
    `事件: ${inc.description}\n` +
    `累積被害: ${inc.damage}\n` +
    `今回進める視点: ${ctx.perspective} (perpetrator=加害者 / victim=被害者)\n` +
    `加害者: ${ctx.perpetrator.name} (${ctx.perpetrator.id})\n` +
    `被害者: ${ctx.victims.map((v) => v.name).join(', ') || 'なし'}\n` +
    `直近ログ:\n${log || '(なし)'}\n` +
    'この視点の次の一手を JSON で返せ。';
  return partsFromSegments('incident', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}

// --- 転: グループ bloc 投票 -------------------------------------------------

export function buildFoolishPrompt(ctx: FoolishVoteContext): PromptParts {
  const sys =
    'あなたは裁判で 1 つの性格グループを代表して投票する。\n' +
    `この事件で「最も愚かしい行動をした」のは誰かを候補から 1 人選ぶ。\n` +
    '出力スキーマ: {"pick": "villagerId"}。pick は必ず候補 id のいずれか。' +
    JSON_ONLY;
  const user =
    `グループの軸: ${PERSONALITY_LABELS[ctx.axis]} (${ctx.axis})\n` +
    `事件: ${ctx.incident.description}\n` +
    `候補:\n${ctx.candidates.map((c) => `- ${c.id}: ${c.name} | ${traitsLine(c.persona.traits)}`).join('\n')}\n` +
    'このグループの価値観で最も愚かな 1 人を JSON で返せ。';
  return partsFromSegments('foolish', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}

export function buildFatePrompt(ctx: FateVoteContext): PromptParts {
  const sys =
    'あなたは裁判で 1 つの性格グループを代表して投票する。\n' +
    '被告を「殺す(kill)」か「活かす(spare→教育)」かを決める。\n' +
    '出力スキーマ: {"verdict": "kill" | "spare"}。' +
    JSON_ONLY;
  const user =
    `グループの軸: ${PERSONALITY_LABELS[ctx.axis]} (${ctx.axis})\n` +
    `事件: ${ctx.incident.description}\n` +
    `被告:\n${villagerBrief(ctx.defendant)}\n` +
    'このグループの価値観で kill / spare を JSON で返せ。';
  return partsFromSegments('fate', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}

// --- 結: 教育内容決定 -------------------------------------------------------

export function buildEducationPrompt(ctx: EducationContext): PromptParts {
  const axisList = PERSONALITY_AXES.map((a) => `${a}(${PERSONALITY_LABELS[a]})`).join(', ');
  const sys =
    'あなたは審判人。活かすと決まった被告を「教育(改変)」または「追放」する。\n' +
    '出力スキーマ (いずれか):\n' +
    '  追放: {"kind": "exile", "villager": "id", "rationale": "理由"}\n' +
    '  教育: {"kind": "educate", "villager": "id", "rationale": "理由", ' +
    '"persona": {"traits": {"<軸>": 差分 -1..1}, "values": ["信条"], "speechStyle": "口調"}, ' +
    '"appearance": {"body": "体", "descriptors": ["特徴"]}}\n' +
    `性格軸: ${axisList}。traits は差分 (例 攻撃性を下げるなら aggression: -0.5)。教育の各サブ項目は任意。` +
    JSON_ONLY;
  const user =
    `事件: ${ctx.incident.description}\n` +
    `被告(改変対象):\n${villagerBrief(ctx.perpetrator)}\n` +
    `改変回数: ${ctx.perpetrator.reformCount}\n` +
    'どう作り替えるか (または追放するか) を JSON で返せ。';
  return partsFromSegments('education', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}

// --- 世界側 LLM: 日末評価 ---------------------------------------------------

export function buildWorldPrompt(ctx: WorldEvalContext): PromptParts {
  const virtueList = VIRTUES.map((v) => `${v}(${VIRTUE_LABELS[v]})`).join(', ');
  const axisList = PERSONALITY_AXES.map((a) => `${a}(${PERSONALITY_LABELS[a]})`).join(', ');
  const sys =
    'あなたは村全体を見る「世界エンジン」。その日の裁判結果から村を評価する。\n' +
    '出力スキーマ: {"reputationDelta": {"<徳目>": 増減 -1..1, ...}, ' +
    '"villagerDeltas": [{"villager": "id", "personalityDelta": {"<軸>": 増減 -1..1}}], ' +
    '"spawn": 0以上の整数(新規出生数), "narrative": "その日の総評(日本語)"}\n' +
    `徳目: ${virtueList}。性格軸: ${axisList}。delta は適用後 0..1 にクランプされる前提の増減。` +
    JSON_ONLY;
  const repLine = VIRTUES.map((v) => `${VIRTUE_LABELS[v]}=${ctx.reputation[v].toFixed(2)}`).join(' ');
  const user =
    `現在の村の評判: ${repLine}\n` +
    `判決: ${ctx.verdict} (death=処刑 / spared=教育)\n` +
    `被告:\n${villagerBrief(ctx.defendant)}\n` +
    `事件: ${ctx.incident.description}\n` +
    `関与者: ${ctx.involved.map((v) => v.name).join(', ') || 'なし'}\n` +
    `暦: ${ctx.calendar.year}年${ctx.calendar.month}月${ctx.calendar.dayOfMonth}日 (${ctx.calendar.season})\n` +
    'この日の村への影響を JSON で返せ。';
  return partsFromSegments('world', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}

// --- 世界側 LLM: 祝日イベント --------------------------------------------------

export function buildHolidayPrompt(ctx: HolidayContext): PromptParts {
  const virtueList = VIRTUES.map((v) => `${v}(${VIRTUE_LABELS[v]})`).join(', ');
  const sys =
    'あなたは村全体を見る「世界エンジン」。祝日にあたる日の、村ぐるみの出来事を 1 つ作る。\n' +
    '出力スキーマ: {"narrative": "祝日にまつわる出来事(日本語1-2文)", ' +
    '"reputationDelta": {"<徳目>": 増減 -1..1, ...}}\n' +
    `徳目: ${virtueList}。祝祭なので活気(vitality)寄りの小さめの delta が自然。delta は適用後 0..1 にクランプされる前提。` +
    JSON_ONLY;
  const cal = ctx.calendar;
  const repLine = VIRTUES.map((v) => `${VIRTUE_LABELS[v]}=${ctx.reputation[v].toFixed(2)}`).join(' ');
  const names = ctx.villagers.slice(0, 8).map((v) => `${v.name}(${v.species})`).join(', ');
  const user =
    `祝日: ${ctx.holiday}\n` +
    `暦: ${cal.year}年${cal.month}月${cal.dayOfMonth}日 (${cal.season})\n` +
    `村の評判: ${repLine}\n` +
    `村のどうぶつ: ${names || 'なし'}\n` +
    'この祝日に村で起きる出来事を JSON で返せ。';
  return partsFromSegments('world', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}
