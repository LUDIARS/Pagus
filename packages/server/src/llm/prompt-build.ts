// 各 Brain / WorldBrain メソッドのプロンプト組み立て。
//
// `@ludiars/llm-gateway` の orderSegments (prefix-cache 整形) / pickTier (tier ルーティング)
// / estimateTokens (概算トークン) を使う。固定指示 (出力規約) は fixed 断片、文脈は volatile
// 断片に置き、不変プレフィックスを前に寄せてキャッシュヒット率を上げる。
//
// 各プロンプトは「JSON だけで返せ」と指示し、返り値スキーマを sim 型に一致させる。

import { orderSegments, pickTier, estimateTokens } from '@ludiars/llm-gateway';
import type { Segment, Tier } from '@ludiars/llm-gateway';
import { storyContext } from './story-context.js';

import {
  PERSONALITY_AXES,
  PERSONALITY_LABELS,
  VIRTUES,
  VIRTUE_LABELS,
  lifeProfileFor,
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
  MonthlyScheduleContext,
  IncidentDesignContext,
  RuleProposalContext,
  Villager,
  VillageRule,
  Personality,
  BehaviorRule,
  DistillContext,
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

/** 住民を 1 行で (id 付き)。スケジュール/デザインの一覧で使う。 */
function villagerLine(v: Villager): string {
  const profile = lifeProfileFor(v);
  return `- ${v.id}: ${v.name} (${v.species}) | 職能=${profile.label} hobby=${v.hobby} values=${v.persona.values.join(' / ') || 'なし'} | ${traitsLine(v.persona.traits)}`;
}

/** 村のしきたり一覧 (事件の火種)。 */
function rulesBlock(rules: VillageRule[]): string {
  if (rules.length === 0) return '(なし)';
  return rules.map((r) => `- ${r.text}`).join('\n');
}

function villagerBrief(v: Villager): string {
  const e = Object.entries(v.emotion.axes)
    .map(([k, n]) => `${k}:${n.toFixed(2)}`)
    .join(' ');
  return [
    `${v.name} (${v.species}, id=${v.id})`,
    `性格: ${traitsLine(v.persona.traits)}`,
    `信条: ${v.persona.values.join(' / ') || 'なし'}`,
    `生活: ${lifeProfileFor(v).label} / 趣味=${v.hobby}`,
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
    (env.townActivity ? `街での日課: ${env.townActivity} / 行き先: ${env.townSite}\n` : '') +
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
    (env.townActivity ? `街での日課: ${env.townActivity} / 行き先: ${env.townSite}\n` : '') +
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
    'damageDelta は被害の増分。ended=true で事件を打ち切れる。事件記録がある場合、記録に反する新事実や無根拠な真犯人の断定はしない。' +
    JSON_ONLY;
  const inc = ctx.incident;
  const log = inc.steps
    .slice(-4)
    .map((s) => `- [${s.perspective}] ${s.action} (+${s.damageDelta})`)
    .join('\n');
  const user =
    `事件: ${inc.description}\n` +
    (inc.story ? `事件記録: ${JSON.stringify(inc.story)}\n` : '') +
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
    storyContext(ctx.incident, 'foolish') +
    `候補:\n${ctx.candidates.map((c) => `- ${c.id}: ${c.name} | ${traitsLine(c.persona.traits)}`).join('\n')}\n` +
    'このグループの価値観で最も愚かな 1 人を JSON で返せ。';
  return partsFromSegments('foolish', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}

/** 判例化 (blackbox) 用の追加文脈。features は fate-blackbox.fateFeatures と同じ map。 */
export interface FateRuleHint {
  features: Record<string, string | number | boolean>;
  retiredRules: Array<{ description: string; whenText: string }>;
}

export function buildFatePrompt(ctx: FateVoteContext, ruleHint?: FateRuleHint): PromptParts {
  const ruleSys = ruleHint
    ? '\nさらに、この量刑判断が特徴量の単純な条件で再現できるなら proposedRule に「判例」を書け:\n' +
      '{"verdict": ..., "confidence": 0.0-1.0, "rationale": "一言",\n' +
      ' "proposedRule": {"description":"判例の説明","when":{"op":"and","clauses":[{"op":"cmp","feature":"axis","cmp":"==","value":"aggression"},{"op":"cmp","feature":"damage","cmp":">=","value":30}]},"output":{"verdict":"kill"},"confidence":0.8}}\n' +
      '使える feature: axis(グループ軸), damage(被害量), involvedCount, reformCount, madman, scummy, stress, dominantTrait(被告の最強気質), aggression, kindness。\n' +
      'proposedRule は自信が無ければ省略可。'
    : '';
  const sys =
    'あなたは裁判で 1 つの性格グループを代表して投票する。\n' +
    '被告を「殺す(kill)」か「活かす(spare→教育)」かを決める。\n' +
    '出力スキーマ: {"verdict": "kill" | "spare"}。' +
    ruleSys +
    JSON_ONLY;
  const hintUser = ruleHint
    ? `特徴量: ${JSON.stringify(ruleHint.features)}\n` +
      (ruleHint.retiredRules.length
        ? `撤回済み判例 (同じ提案はしないこと): ${ruleHint.retiredRules.map((r) => `${r.description}[${r.whenText}]`).join(' / ')}\n`
        : '')
    : '';
  const user =
    `グループの軸: ${PERSONALITY_LABELS[ctx.axis]} (${ctx.axis})\n` +
    `事件: ${ctx.incident.description}\n` +
    storyContext(ctx.incident, 'fate') +
    `被告:\n${villagerBrief(ctx.defendant)}\n` +
    hintUser +
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
    '  教育: {"kind": "educate", "villager": "id", "rationale": "理由", "direction": "empathy|discipline|curiosity|ambition", ' +
    '"persona": {"traits": {"<軸>": 差分 -1..1}, "values": ["信条"], "speechStyle": "口調"}, ' +
    '"appearance": {"body": "体", "descriptors": ["特徴"]}}\n' +
    `性格軸: ${axisList}。traits は差分 (例 攻撃性を下げるなら aggression: -0.5)。教育の各サブ項目は任意。` +
    'direction は1つ選ぶ。empathy=共感の触手・加害抑制、discipline=ぜんまい・衝動と噂を抑制、curiosity=第三の目・異変調査割り込み、ambition=ティーポット・収集優先。元の動物種と本人らしさは保ち、理由を事件と結びつける。' +
    JSON_ONLY;
  const user =
    `事件: ${ctx.incident.description}\n` +
    storyContext(ctx.incident, 'decided') +
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

// --- 月次事件: 月初の発生日スケジュール (§12.3.1) ----------------------------

export function buildSchedulePrompt(ctx: MonthlyScheduleContext): PromptParts {
  const virtueList = VIRTUES.map((v) => `${v}(${VIRTUE_LABELS[v]})`).join(', ');
  const sys =
    'あなたは村全体を見る「世界エンジン」。その月に起きる大事件の発生日と大まかなテーマの種を 1 つ決める。\n' +
    '出力スキーマ: {"dayOfMonth": その月の何日に起こすか(整数), "themeSeed": "事件の大まかな種(短い日本語)"}\n' +
    `徳目: ${virtueList}。村の評判・住民・しきたり・職能を踏まえ、波乱が映える発生日を選べ。\n` +
    '当面のサンプル方針: マーダーミステリー / 人狼風の「隠れた犯人・疑心暗鬼・密告・足跡・アリバイ」を優先する。' +
    JSON_ONLY;
  const cal = ctx.calendar;
  const repLine = VIRTUES.map((v) => `${VIRTUE_LABELS[v]}=${ctx.reputation[v].toFixed(2)}`).join(' ');
  const names = ctx.villagers.slice(0, 12).map((v) => `${v.name}(${v.species})`).join(', ');
  const user =
    `暦: ${cal.year}年${cal.month}月 (${cal.season}, 日数=${cal.daysInMonth})\n` +
    `村の評判: ${repLine}\n` +
    `住民 (${ctx.villagers.length}体): ${names || 'なし'}\n` +
    `村のしきたり:\n${rulesBlock(ctx.villageRules)}\n` +
    // 事件アーク (§v1.4-B): 火種由来のヒントがあればテーマの種はそれを必ず採用させる。
    (ctx.arcHint
      ? `くすぶる火種: ${ctx.arcHint.threadNote} (関係者: ${ctx.arcHint.actorNames.join('・') || 'なし'})\n` +
        `themeSeed は必ず「${ctx.arcHint.themeSeed}」を使い、この火種の続きとして設計せよ。\n`
      : '') +
    'この月の事件の発生日とテーマの種を JSON で返せ。';
  return partsFromSegments('world', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}

// --- 月次事件: 前日の詳細デザイン + 事件用キャラ生成 (§12.3.2) ----------------

export function buildDesignPrompt(ctx: IncidentDesignContext): PromptParts {
  const virtueList = VIRTUES.map((v) => `${v}(${VIRTUE_LABELS[v]})`).join(', ');
  const axisList = PERSONALITY_AXES.map((a) => `${a}(${PERSONALITY_LABELS[a]})`).join(', ');
  const sys =
    'あなたは村全体を見る「世界エンジン」。前日の村の様子から、明日起きる事件を詳細にデザインする。\n' +
    '必要なら事件用の新規キャラ (犯人役・探偵役・密告者など) を生成して村に投入できる。\n' +
    '出力スキーマ: {"description": "事件の筋書き(日本語)", ' +
    '"newCharacters": [{"name": "名", "species": "種", "role": "役回り(加害者/被害者など)", ' +
    '"perpetrator": true|false, "activity": "diurnal|nocturnal|crepuscular|always"(任意), ' +
    '"traits": {"<軸>": 0..1}(任意), "values": ["信条"](任意), "speechStyle": "口調"(任意), "body": "姿"(任意)}], ' +
    '"involvedIds": ["巻き込む既存住民id", ...], ' +
    '"perpetratorId": "既存住民が加害者ならそのid / 新規キャラが加害者なら null", ' +
    '"scapegoat": true|false(賢い犯人が罪を擦り付けて居座るか), ' +
    '"framedTargetId": "陥れる既存住民id / 無ければ null"}\n' +
    `徳目: ${virtueList}。性格軸: ${axisList}。traits は 0..1。\n` +
    'perpetratorId と framedTargetId は既存住民の id か null。involvedIds は既存住民の id のみ。\n' +
    '当面のサンプル方針: マーダーミステリー / 人狼風。住民の職能・趣味・信条を証拠や疑惑に使い、音楽家なら騒音、収集家なら盗難疑惑、料理人なら食卓の事故のように生活由来の火種を強める。' +
    JSON_ONLY;
  const cal = ctx.calendar;
  const repLine = VIRTUES.map((v) => `${VIRTUE_LABELS[v]}=${ctx.reputation[v].toFixed(2)}`).join(' ');
  const culprits =
    ctx.survivingCulprits.length > 0
      ? ctx.survivingCulprits.map((v) => `- ${v.id}: ${v.name} (${v.species})`).join('\n')
      : '(なし)';
  const user =
    `暦: ${cal.year}年${cal.month}月${cal.dayOfMonth}日 (${cal.season})\n` +
    `テーマの種: ${ctx.themeSeed}\n` +
    `村の評判: ${repLine}\n` +
    `既存住民:\n${ctx.villagers.map(villagerLine).join('\n') || '(なし)'}\n` +
    `村のしきたり:\n${rulesBlock(ctx.villageRules)}\n` +
    `居座る過去の事件犯 (連続犯の継続入力):\n${culprits}\n` +
    // 火種 (§v1.4-B): 事件デザインの文脈として渡す (どう拾うかは LLM の裁量)。
    `くすぶる火種:\n${ctx.plotThreads.map((t) => `- [${t.kind}] ${t.note} (熱${t.heat.toFixed(2)})`).join('\n') || '(なし)'}\n` +
    '明日の事件の詳細デザインを JSON で返せ。';
  return partsFromSegments('world', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}

// --- ふるまいの法則の起案 (RuleSmith, §2.1) ----------------------------------

/** 既存ルールを 1 行で (重複起案を避けるための提示)。 */
function ruleLine(r: BehaviorRule): string {
  return `- [${r.source}] ${r.description}`;
}

export function buildRulePrompt(ctx: RuleProposalContext): PromptParts {
  const virtueList = VIRTUES.map((v) => `${v}(${VIRTUE_LABELS[v]})`).join(', ');
  const axisList = PERSONALITY_AXES.map((a) => `${a}(${PERSONALITY_LABELS[a]})`).join(', ');
  const sys =
    'あなたは村の「ふるまいの法則」を編む者。村のどうぶつの感情・行動を決める安全なルールを 1 つ起案する。\n' +
    'ルールは閉じた DSL に従う。条件 (when) は AND、効果 (then) は集約される。\n' +
    '出力スキーマ: {"description": "ルールの説明(短い日本語)", ' +
    '"when": [<条件>...], "then": [<効果>...]}\n' +
    '条件 (kind と付随フィールド):\n' +
    '  {"kind":"traitAbove","axis":<気質軸>,"value":0..1} / {"kind":"traitBelow","axis":<気質軸>,"value":0..1}\n' +
    '  {"kind":"emotionAbove","emotionAxis":"anger|joy|fear など","value":-1..1}\n' +
    '  {"kind":"eventParamAbove","tag":"incidentExposure など","value":数値}\n' +
    '  {"kind":"place","place":"広場|住宅地|村はずれ"} / {"kind":"timeOfDay","timeOfDay":"night|morning|noon|evening"}\n' +
    '  {"kind":"hasNeighbor"} / {"kind":"species","species":"猫 など"} / {"kind":"activity","activity":"diurnal|nocturnal|crepuscular|always"}\n' +
    '  {"kind":"hobby","hobby":"ascetic|collector|social|fashion|gourmet|gamble"} / {"kind":"valueIncludes","text":"音楽 など"}\n' +
    '  {"kind":"wealthBelow","value":数値} / {"kind":"wealthAbove","value":数値} / {"kind":"actionCategory","category":"harass|good|chat|wander"}\n' +
    '効果 (kind と付随フィールド):\n' +
    '  {"kind":"emotionDelta","emotionAxis":"anger|joy など","delta":-1..1}\n' +
    '  {"kind":"triggerWeight","delta":-5..5(事件化しやすさ)} / {"kind":"actionFlavor","text":"行動文の差し替え"}\n' +
    `気質軸: ${axisList}。徳目: ${virtueList}。when と then は最低 1 件。既存と重複しない新味のあるルールを。\n` +
    '事件提案がある場合は、そのテーマを日常に滲ませるルールへ落とし込む。例: 音楽家の夜演奏→騒音事件化、収集家→盗難疑惑、人狼風テーマ→夜・噂・密談で疑心暗鬼が増える。' +
    JSON_ONLY;
  const cal = ctx.calendar;
  const repLine = VIRTUES.map((v) => `${VIRTUE_LABELS[v]}=${ctx.reputation[v].toFixed(2)}`).join(' ');
  const existing = ctx.existingRules.map(ruleLine).join('\n') || '(なし)';
  const names = ctx.villagers.slice(0, 12).map((v) => {
    const p = lifeProfileFor(v);
    return `${v.name}(${v.species}/${p.label}/${v.hobby})`;
  }).join(', ');
  const scheduled = ctx.scheduledIncident
    ? `${ctx.scheduledIncident.dayOfMonth}日: ${ctx.scheduledIncident.themeSeed}` +
      (ctx.scheduledIncident.design ? ` / ${ctx.scheduledIncident.design.description}` : '')
    : '(なし)';
  const user =
    `暦: ${cal.year}年${cal.month}月${cal.dayOfMonth}日 (${cal.season})\n` +
    `村の評判: ${repLine}\n` +
    `住民 (${ctx.villagers.length}体): ${names || 'なし'}\n` +
    `予定・提案済みの事件:\n${scheduled}\n` +
    `既存のふるまいの法則:\n${existing}\n` +
    '村の今の様子に映える新しいふるまいの法則を 1 つ JSON で返せ。';
  return partsFromSegments('rule', [
    { stability: 'fixed', role: 'system', text: sys },
    { stability: 'volatile', role: 'user', text: user },
  ]);
}

// --- 蒸留 (§v1.4-C): 乖離ケースを説明するルールを起案する --------------------

export function buildDistillPrompt(ctx: DistillContext): PromptParts {
  const axisList = PERSONALITY_AXES.map((a) => `${a}(${PERSONALITY_LABELS[a]})`).join(', ');
  const sys =
    'あなたは村の「ふるまいの法則」を蒸留する者。教師 (大きな知能) と生徒 (ルールエンジン) の判断が' +
    '食い違ったケース群を観て、その食い違いを説明する安全なルールを 1 つだけ起案する。\n' +
    '出力スキーマ: {"description": "ルールの説明(短い日本語)", "when": [<条件>...], "then": [<効果>...]}\n' +
    '条件 (kind):\n' +
    '  {"kind":"traitAbove"|"traitBelow","axis":<気質軸>,"value":0..1}\n' +
    '  {"kind":"emotionAbove"|"emotionBelow","emotionAxis":"anger|joy など","value":-1..1}\n' +
    '  {"kind":"eventParamAbove","tag":"...","value":数値} / {"kind":"stressAbove","value":数値}\n' +
    '  {"kind":"wealthBelow"|"wealthAbove","value":数値}\n' +
    '  {"kind":"place","place":"広場|住宅地|村はずれ"} / {"kind":"placeState","state":"defiled|blessed"}\n' +
    '  {"kind":"timeOfDay","timeOfDay":"night|morning|noon|evening"} / {"kind":"hasNeighbor"}\n' +
    '  {"kind":"infoContains","substr":"..."} / {"kind":"infoFromPlayer"} / {"kind":"actionCategory","category":"harass|good|chat|wander"}\n' +
    '効果 (kind):\n' +
    '  {"kind":"emotionDelta","emotionAxis":"...","delta":-1..1} / {"kind":"triggerWeight","delta":-5..5}\n' +
    '  {"kind":"actionFlavor","text":"..."} / {"kind":"spreadInfo"} / {"kind":"moveBias","towards":"partner|admire|awayMadman"} / {"kind":"wealthDelta","delta":-20..20}\n' +
    `気質軸: ${axisList}。ケース群に共通する条件を when に、教師の傾向 (感情の向き/事件化) を then に写せ。` +
    JSON_ONLY;
  const caseLines = ctx.cases
    .map((c, i) => {
      const teacherEmo = Object.entries(c.teacher.emotionDelta)
        .filter(([, d]) => Math.abs(d) > 0.01)
        .map(([k, d]) => `${k}${d > 0 ? '+' : ''}${d.toFixed(2)}`)
        .join(' ') || '(変化なし)';
      return (
        `#${i + 1} 場所=${c.env.place}${c.env.placeState ? `(${c.env.placeState})` : ''} 時間=${c.env.timeOfDay} ` +
        `隣人=${c.env.hasNeighbor ? 'あり' : 'なし'} ストレス=${c.villager.stress} 所持金=${Math.round(c.villager.wealth)}\n` +
        `   教師: 感情 ${teacherEmo} / 事件化=${c.teacher.triggersIncident} — 生徒: 事件化=${c.student.triggersIncident}`
      );
    })
    .join('\n');
  const existing = ctx.existingRules.map(ruleLine).join('\n') || '(なし)';
  const user =
    `乖離ケース (${ctx.cases.length}件):\n${caseLines}\n` +
    `既存のふるまいの法則:\n${existing}\n` +
    'これらの乖離を最もよく説明するふるまいの法則を 1 つ JSON で返せ。';
  return partsFromSegments('rule', [
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
