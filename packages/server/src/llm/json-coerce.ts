// LLM の JSON 応答を sim 型へ検証変換する純関数群。
// 不正な応答は throw (= LlmBrain がリトライ→なお失敗で throw)。無言フォールバック禁止。

import {
  PERSONALITY_AXES,
  VIRTUES,
} from '@pagus/sim';
import type {
  EmotionState,
  ActionDecision,
  IncidentStep,
  Reform,
  VillagerId,
  DayEvaluation,
  HolidayEvent,
  PersonalityAxis,
  Personality,
  Virtue,
  VirtueVector,
  MonthlySchedule,
  IncidentDesign,
  IncidentCharacterSpec,
  ActivityPattern,
  BehaviorRule,
  RuleCondition,
  RuleEffect,
  RuleCategory,
  TimeOfDay,
  Hobby,
} from '@pagus/sim';

const ACTIVITY_SET = new Set<ActivityPattern>(['diurnal', 'nocturnal', 'crepuscular', 'always']);
const HOBBY_SET = new Set<Hobby>(['ascetic', 'collector', 'social', 'fashion', 'gourmet', 'gamble']);

const AXIS_SET = new Set<string>(PERSONALITY_AXES);
const VIRTUE_SET = new Set<string>(VIRTUES);
const TIME_OF_DAY_SET = new Set<TimeOfDay>(['night', 'morning', 'noon', 'evening']);
const RULE_CATEGORY_SET = new Set<RuleCategory>(['harass', 'good', 'chat', 'wander']);

/** LLM 出力テキストから JSON オブジェクトを取り出す (コードフェンス除去込み)。 */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && typeof fence[1] === 'string') t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`JSON オブジェクトが見つかりません: ${text.slice(0, 120)}`);
  }
  return JSON.parse(t.slice(start, end + 1));
}

function asObj(u: unknown): Record<string, unknown> {
  if (typeof u !== 'object' || u === null || Array.isArray(u)) {
    throw new Error('JSON オブジェクトを期待しましたが違いました');
  }
  return u as Record<string, unknown>;
}

function asNumber(u: unknown, field: string): number {
  if (typeof u !== 'number' || Number.isNaN(u)) throw new Error(`${field} が数値ではありません`);
  return u;
}

function asString(u: unknown, field: string): string {
  if (typeof u !== 'string' || u.length === 0) throw new Error(`${field} が非空文字列ではありません`);
  return u;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** axes: Record<string,number> を検証 ([-1,1] にクランプ)。 */
function coerceAxes(u: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (u === undefined || u === null) return out;
  const o = asObj(u);
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'number' && !Number.isNaN(v)) out[k] = clamp(v, -1, 1);
  }
  return out;
}

export function coerceEmotion(u: unknown): EmotionState {
  const o = asObj(u);
  return { axes: coerceAxes(o.axes), label: asString(o.label, 'label') };
}

/** Partial<Personality> (既知軸のみ、[-1,1] クランプ)。 */
function coercePersonalityDelta(u: unknown): Partial<Personality> {
  const out: Partial<Personality> = {};
  if (u === undefined || u === null) return out;
  const o = asObj(u);
  for (const [k, v] of Object.entries(o)) {
    if (AXIS_SET.has(k) && typeof v === 'number' && !Number.isNaN(v)) {
      out[k as PersonalityAxis] = clamp(v, -1, 1);
    }
  }
  return out;
}

export function coerceAction(u: unknown): ActionDecision {
  const o = asObj(u);
  const triggers = o.triggersIncident === true;

  let move: ActionDecision['move'] = null;
  if (o.move !== null && o.move !== undefined) {
    const m = asObj(o.move);
    move = { x: Math.round(asNumber(m.x, 'move.x')), y: Math.round(asNumber(m.y, 'move.y')) };
  }

  let incidentSeed: ActionDecision['incidentSeed'] = null;
  if (triggers) {
    if (o.incidentSeed === null || o.incidentSeed === undefined) {
      throw new Error('triggersIncident=true だが incidentSeed がありません');
    }
    const s = asObj(o.incidentSeed);
    const involvedRaw = Array.isArray(s.involved) ? s.involved : [];
    const involved = involvedRaw.filter((x): x is string => typeof x === 'string');
    incidentSeed = { description: asString(s.description, 'incidentSeed.description'), involved };
  }

  return {
    move,
    action: asString(o.action, 'action'),
    newEmotion: coerceEmotion(o.newEmotion),
    triggersIncident: triggers,
    incidentSeed,
  };
}

export function coerceIncidentStep(u: unknown): IncidentStep {
  const o = asObj(u);
  return {
    action: asString(o.action, 'action'),
    damageDelta: Math.max(0, asNumber(o.damageDelta, 'damageDelta')),
    ended: o.ended === true,
  };
}

/** foolish 投票: candidates の id 集合に属することを保証。 */
export function coerceFoolishPick(u: unknown, allowed: ReadonlySet<VillagerId>): VillagerId {
  const o = asObj(u);
  const pick = asString(o.pick, 'pick');
  if (!allowed.has(pick)) throw new Error(`pick '${pick}' は候補にありません`);
  return pick;
}

export function coerceFate(u: unknown): 'kill' | 'spare' {
  const o = asObj(u);
  const v = asString(o.verdict, 'verdict');
  if (v !== 'kill' && v !== 'spare') throw new Error(`verdict は kill|spare: ${v}`);
  return v;
}

/** fate 投票 + 判例候補 (blackbox 用)。verdict 以外は任意で、不正でも落とさず捨てる。 */
export interface FateJudgement {
  verdict: 'kill' | 'spare';
  confidence: number;
  rationale: string;
  /** 判例候補 (raw)。検証は fate-blackbox.parseProposedFateRule で行う。 */
  proposedRule: unknown;
}

export function coerceFateJudgement(u: unknown): FateJudgement {
  const verdict = coerceFate(u);
  const o = asObj(u);
  const confidence =
    typeof o.confidence === 'number' && !Number.isNaN(o.confidence)
      ? Math.min(1, Math.max(0, o.confidence))
      : 0.7;
  const rationale = typeof o.rationale === 'string' ? o.rationale : 'グループ投票';
  return { verdict, confidence, rationale, proposedRule: o.proposedRule ?? null };
}

export function coerceReform(u: unknown, targetId: VillagerId): Reform {
  const o = asObj(u);
  const kind = o.kind;
  const rationale = asString(o.rationale, 'rationale');
  // villager は対象が確定しているので targetId を優先 (LLM の取り違え防止)。
  if (kind === 'exile') {
    return { kind: 'exile', villager: targetId, rationale };
  }
  if (kind === 'educate') {
    const reform: Reform = { kind: 'educate', villager: targetId, rationale };
    if (o.direction !== undefined) {
      if (o.direction !== 'empathy' && o.direction !== 'discipline' && o.direction !== 'curiosity' && o.direction !== 'ambition') {
        throw new Error('Reform.direction は empathy|discipline|curiosity|ambition');
      }
      reform.direction = o.direction;
    }
    if (o.persona !== undefined && o.persona !== null) {
      const p = asObj(o.persona);
      const persona: NonNullable<Extract<Reform, { kind: 'educate' }>['persona']> = {};
      if (p.traits !== undefined) persona.traits = coercePersonalityDelta(p.traits);
      if (Array.isArray(p.values)) {
        persona.values = p.values.filter((x): x is string => typeof x === 'string');
      }
      if (typeof p.speechStyle === 'string' && p.speechStyle.length > 0) {
        persona.speechStyle = p.speechStyle;
      }
      if (Object.keys(persona).length > 0) reform.persona = persona;
    }
    if (o.appearance !== undefined && o.appearance !== null) {
      const a = asObj(o.appearance);
      const appearance: NonNullable<Extract<Reform, { kind: 'educate' }>['appearance']> = {};
      if (typeof a.body === 'string' && a.body.length > 0) appearance.body = a.body;
      if (Array.isArray(a.descriptors)) {
        appearance.descriptors = a.descriptors.filter((x): x is string => typeof x === 'string');
      }
      if (Object.keys(appearance).length > 0) reform.appearance = appearance;
    }
    if (o.emotion !== undefined && o.emotion !== null) {
      reform.emotion = coerceEmotion(o.emotion);
    }
    return reform;
  }
  throw new Error(`Reform.kind は exile|educate: ${String(kind)}`);
}

/** Partial<VirtueVector> (既知徳目のみ、[-1,1] クランプ)。 */
function coerceVirtueDelta(u: unknown): Partial<VirtueVector> {
  const out: Partial<VirtueVector> = {};
  if (u === undefined || u === null) return out;
  const o = asObj(u);
  for (const [k, v] of Object.entries(o)) {
    if (VIRTUE_SET.has(k) && typeof v === 'number' && !Number.isNaN(v)) {
      out[k as Virtue] = clamp(v, -1, 1);
    }
  }
  return out;
}

export function coerceHolidayEvent(u: unknown): HolidayEvent {
  const o = asObj(u);
  return {
    narrative: asString(o.narrative, 'narrative'),
    reputationDelta: coerceVirtueDelta(o.reputationDelta),
  };
}

export function coerceDayEvaluation(u: unknown): DayEvaluation {
  const o = asObj(u);
  const deltasRaw = Array.isArray(o.villagerDeltas) ? o.villagerDeltas : [];
  const villagerDeltas: DayEvaluation['villagerDeltas'] = [];
  for (const d of deltasRaw) {
    const dd = asObj(d);
    if (typeof dd.villager !== 'string' || dd.villager.length === 0) continue;
    villagerDeltas.push({
      villager: dd.villager,
      personalityDelta: coercePersonalityDelta(dd.personalityDelta),
    });
  }
  return {
    reputationDelta: coerceVirtueDelta(o.reputationDelta),
    villagerDeltas,
    spawn: Math.max(0, Math.round(asNumber(o.spawn, 'spawn'))),
    narrative: asString(o.narrative, 'narrative'),
  };
}

// --- 月次事件 (§12.3) -------------------------------------------------------

/** null/未定義/空/非文字列は null、非空文字列はそのまま (id 系の許容変換)。 */
function asNullableId(u: unknown): VillagerId | null {
  return typeof u === 'string' && u.length > 0 ? u : null;
}

/** 文字列配列を抽出 (非文字列を捨てる)。 */
function asStringArray(u: unknown): string[] {
  return Array.isArray(u) ? u.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

export function coerceMonthlySchedule(u: unknown): MonthlySchedule {
  const o = asObj(u);
  return {
    dayOfMonth: Math.round(asNumber(o.dayOfMonth, 'dayOfMonth')),
    themeSeed: asString(o.themeSeed, 'themeSeed'),
  };
}

/** 事件用キャラ 1 体の仕様を検証する。 */
function coerceIncidentCharacter(u: unknown): IncidentCharacterSpec {
  const o = asObj(u);
  const spec: IncidentCharacterSpec = {
    name: asString(o.name, 'newCharacters[].name'),
    species: asString(o.species, 'newCharacters[].species'),
    role: asString(o.role, 'newCharacters[].role'),
    perpetrator: o.perpetrator === true,
  };
  // 任意項目は値があるときだけキーを足す (exactOptionalPropertyTypes)。
  if (typeof o.activity === 'string' && ACTIVITY_SET.has(o.activity as ActivityPattern)) {
    spec.activity = o.activity as ActivityPattern;
  }
  if (o.traits !== undefined && o.traits !== null) spec.traits = coercePersonalityDelta(o.traits);
  if (Array.isArray(o.values)) spec.values = asStringArray(o.values);
  if (typeof o.speechStyle === 'string' && o.speechStyle.length > 0) spec.speechStyle = o.speechStyle;
  if (typeof o.body === 'string' && o.body.length > 0) spec.body = o.body;
  return spec;
}

export function coerceIncidentDesign(u: unknown): IncidentDesign {
  const o = asObj(u);
  const charsRaw = Array.isArray(o.newCharacters) ? o.newCharacters : [];
  const newCharacters = charsRaw.map(coerceIncidentCharacter);
  return {
    description: asString(o.description, 'description'),
    newCharacters,
    involvedIds: asStringArray(o.involvedIds),
    perpetratorId: asNullableId(o.perpetratorId),
    scapegoat: o.scapegoat === true,
    framedTargetId: asNullableId(o.framedTargetId),
  };
}

// --- ふるまいの法則 (§2.1) ----------------------------------------------------

/** ルール条件 1 件を厳密に検証する (未知 kind/軸/値域は throw)。無言フォールバック禁止。 */
function coerceRuleCondition(u: unknown): RuleCondition {
  const o = asObj(u);
  const kind = o.kind;
  switch (kind) {
    case 'traitAbove':
    case 'traitBelow': {
      const axis = asString(o.axis, 'when.axis');
      if (!AXIS_SET.has(axis)) throw new Error(`when.axis が未知の気質軸です: ${axis}`);
      return { kind, axis: axis as PersonalityAxis, value: clamp(asNumber(o.value, 'when.value'), 0, 1) };
    }
    case 'emotionAbove':
      return { kind, emotionAxis: asString(o.emotionAxis, 'when.emotionAxis'), value: clamp(asNumber(o.value, 'when.value'), -1, 1) };
    case 'eventParamAbove':
      return { kind, tag: asString(o.tag, 'when.tag'), value: asNumber(o.value, 'when.value') };
    case 'place':
      return { kind, place: asString(o.place, 'when.place') };
    case 'timeOfDay': {
      const t = asString(o.timeOfDay, 'when.timeOfDay');
      if (!TIME_OF_DAY_SET.has(t as TimeOfDay)) throw new Error(`when.timeOfDay が未知です: ${t}`);
      return { kind, timeOfDay: t as TimeOfDay };
    }
    case 'hasNeighbor':
      return { kind };
    case 'species':
      return { kind, species: asString(o.species, 'when.species') };
    case 'activity': {
      const activity = asString(o.activity, 'when.activity');
      if (!ACTIVITY_SET.has(activity as ActivityPattern)) throw new Error(`when.activity が未知です: ${activity}`);
      return { kind, activity: activity as ActivityPattern };
    }
    case 'hobby': {
      const hobby = asString(o.hobby, 'when.hobby');
      if (!HOBBY_SET.has(hobby as Hobby)) throw new Error(`when.hobby が未知です: ${hobby}`);
      return { kind, hobby: hobby as Hobby };
    }
    case 'valueIncludes':
      return { kind, text: asString(o.text, 'when.text') };
    case 'actionCategory': {
      const c = asString(o.category, 'when.category');
      if (!RULE_CATEGORY_SET.has(c as RuleCategory)) throw new Error(`when.category が未知です: ${c}`);
      return { kind, category: c as RuleCategory };
    }
    case 'wealthBelow':
    case 'wealthAbove':
      return { kind, value: Math.max(0, asNumber(o.value, 'when.value')) };
    case 'placeState': {
      const st = asString(o.state, 'when.state');
      if (st !== 'defiled' && st !== 'blessed') throw new Error(`when.state が未知です: ${st}`);
      return { kind, state: st };
    }
    // --- DSL v2 (§v1.4-C) ---
    case 'infoContains':
      return { kind, substr: asString(o.substr, 'when.substr') };
    case 'infoFromPlayer':
      return { kind };
    case 'stressAbove':
      return { kind, value: asNumber(o.value, 'when.value') };
    case 'emotionBelow':
      return { kind, emotionAxis: asString(o.emotionAxis, 'when.emotionAxis'), value: clamp(asNumber(o.value, 'when.value'), -1, 1) };
    default:
      throw new Error(`未知のルール条件 kind です: ${String(kind)}`);
  }
}

/** ルール効果 1 件を厳密に検証する (未知 kind/値域は throw)。delta は安全域にクランプ。 */
function coerceRuleEffect(u: unknown): RuleEffect {
  const o = asObj(u);
  const kind = o.kind;
  switch (kind) {
    case 'emotionDelta':
      return { kind, emotionAxis: asString(o.emotionAxis, 'then.emotionAxis'), delta: clamp(asNumber(o.delta, 'then.delta'), -1, 1) };
    case 'triggerWeight':
      // 暴走防止に triggerWeight の絶対値を抑える。
      return { kind, delta: clamp(asNumber(o.delta, 'then.delta'), -5, 5) };
    case 'actionFlavor':
      return { kind, text: asString(o.text, 'then.text') };
    // --- DSL v2 (§v1.4-C) ---
    case 'spreadInfo':
      return { kind };
    case 'moveBias': {
      const t = asString(o.towards, 'then.towards');
      if (t !== 'partner' && t !== 'admire' && t !== 'awayMadman') throw new Error(`then.towards が未知です: ${t}`);
      return { kind, towards: t };
    }
    case 'wealthDelta':
      // 暴走防止に所持金の増減幅を抑える。
      return { kind, delta: clamp(asNumber(o.delta, 'then.delta'), -20, 20) };
    default:
      throw new Error(`未知のルール効果 kind です: ${String(kind)}`);
  }
}

/**
 * LLM が起案した ふるまいの法則 を厳密検証して BehaviorRule に整える (§2.1)。
 * 未知 kind/軸/値域は弾く。source は 'haiku' 固定、id は呼び出し側で採番される前提のプレースホルダ。
 * when/then が空なら無効 (何もしないルール) として throw。
 */
export function coerceBehaviorRule(u: unknown): BehaviorRule {
  const o = asObj(u);
  const whenRaw = Array.isArray(o.when) ? o.when : [];
  const thenRaw = Array.isArray(o.then) ? o.then : [];
  const when = whenRaw.map(coerceRuleCondition);
  const then = thenRaw.map(coerceRuleEffect);
  if (when.length === 0) throw new Error('ふるまいの法則: when (条件) が空です');
  if (then.length === 0) throw new Error('ふるまいの法則: then (効果) が空です');
  const id = typeof o.id === 'string' && o.id.length > 0 ? o.id : 'rule_haiku';
  return {
    id,
    source: 'haiku',
    description: asString(o.description, 'description'),
    when,
    then,
  };
}
