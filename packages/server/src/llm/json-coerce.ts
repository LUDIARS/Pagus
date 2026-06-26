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
} from '@pagus/sim';

const AXIS_SET = new Set<string>(PERSONALITY_AXES);
const VIRTUE_SET = new Set<string>(VIRTUES);

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
