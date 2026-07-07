import { createVillager } from './villager-factory.js';
import type {
  GridPos,
  ResidentHistoryEntry,
  Villager,
  VillagerActionEntry,
  VillagerGachaKind,
  VillagerId,
  VillagerRelationship,
  World,
} from './types/index.js';
import type { PersonalityAxis } from './personality.js';

export const KARMA_GACHA_COST = 35;
const ACTION_LOG_CAP = 300;
const REL_HATE_THRESHOLD = -35;
const REL_LIKE_THRESHOLD = 45;

interface Archetype {
  id: string;
  label: string;
  weight: number;
  traits: Partial<Record<PersonalityAxis, number>>;
  values: string[];
  speechStyle: string;
}

const FREE_ARCHETYPES: Archetype[] = [
  {
    id: 'neighbor',
    label: '平凡な隣人',
    weight: 4,
    traits: { kindness: 0.55, sociability: 0.55, discipline: 0.45, curiosity: 0.4 },
    values: ['ほどほどに助け合う', '静かな暮らし'],
    speechStyle: '素直で控えめ',
  },
  {
    id: 'maker',
    label: '手仕事好き',
    weight: 3,
    traits: { kindness: 0.45, curiosity: 0.65, discipline: 0.7, ambition: 0.35 },
    values: ['手を動かす', '道具を大切にする'],
    speechStyle: '短く実務的',
  },
  {
    id: 'wanderer',
    label: '気ままな旅人',
    weight: 2,
    traits: { curiosity: 0.75, sociability: 0.45, discipline: 0.25, ambition: 0.45 },
    values: ['新しい景色', '束縛されないこと'],
    speechStyle: '軽く飄々としている',
  },
];

const KARMA_ARCHETYPES: Archetype[] = [
  {
    id: 'cunning',
    label: '狡猾な策士',
    weight: 4,
    traits: { kindness: 0.15, aggression: 0.65, sociability: 0.75, curiosity: 0.65, discipline: 0.45, ambition: 0.9 },
    values: ['勝てる筋を読む', '恩を貸して支配する'],
    speechStyle: '柔らかいが底が読めない',
  },
  {
    id: 'cultSaint',
    label: '教祖的な聖人',
    weight: 4,
    traits: { kindness: 0.95, aggression: 0.05, sociability: 0.9, curiosity: 0.55, discipline: 0.8, ambition: 0.8 },
    values: ['救済を語る', '群れの心を束ねる'],
    speechStyle: '穏やかで断定的',
  },
  {
    id: 'holySchemer',
    label: '慈悲深い扇動者',
    weight: 2,
    traits: { kindness: 0.7, aggression: 0.4, sociability: 0.85, curiosity: 0.5, discipline: 0.65, ambition: 0.85 },
    values: ['善意で人を動かす', '正しさを広げる'],
    speechStyle: '親密で熱を帯びる',
  },
];

const FIRST = ['アサ', 'ミナ', 'トウ', 'リツ', 'カナ', 'ソウ', 'ユエ', 'ナギ', 'イオ', 'セナ', 'ハル', 'ユキ', 'メイ', 'ロカ', 'サヨ'];
const LAST = ['リ', 'カ', 'ノ', 'ハ', 'ト', 'ヤ', 'ミ', 'セ', 'ル', 'キ', 'ナ', 'ラ', 'モ', 'ネ', 'ヒ'];
const SPECIES = ['人間', '猫人', '森人', '硝子人', '機械人'];

export interface GachaResult {
  villager: Villager;
  history: ResidentHistoryEntry;
  relationships: VillagerRelationship[];
  cost: number;
}

export interface VillagerNamingRecord {
  villagerId: VillagerId;
  originalName: string;
  assignedName: string;
  namedById: VillagerId;
  namedByName: string;
}

export function rollVillagerGacha(
  world: World,
  kind: VillagerGachaKind,
  opts: { llmBrain?: string | null; rng?: () => number } = {},
): GachaResult {
  const rng = opts.rng ?? Math.random;
  const archetype = pick(kind === 'karma' ? KARMA_ARCHETYPES : FREE_ARCHETYPES, rng);
  const seq = world.residentHistory.filter((h) => h.origin === 'freeGacha' || h.origin === 'karmaGacha').length + 1;
  const id = `gacha_${world.term}_${seq}_${Math.floor(rng() * 10000)}`;
  const villager = createVillager({
    id,
    name: uniqueVillagerName(world, rng),
    species: SPECIES[Math.floor(rng() * SPECIES.length)] ?? SPECIES[0]!,
    position: randomPos(world, rng),
    traits: jitterTraits(archetype.traits, rng),
    values: archetype.values,
    speechStyle: archetype.speechStyle,
    body: 'human',
    origin: 'born',
  });
  world.villagers.set(villager.id, villager);

  const history = addResidentHistory(world, villager, {
    origin: kind === 'karma' ? 'karmaGacha' : 'freeGacha',
    llmBrain: opts.llmBrain ?? null,
    archetype: archetype.label,
  });
  const relationships = connectNewVillager(world, villager, rng);
  return { villager, history, relationships, cost: kind === 'karma' ? KARMA_GACHA_COST : 0 };
}

export function generateVillagerName(rng: () => number = Math.random): string {
  return `${FIRST[Math.floor(rng() * FIRST.length)]}${LAST[Math.floor(rng() * LAST.length)]}`;
}

export function generateUniqueVillagerName(world: World, rng: () => number = Math.random): string {
  return uniqueVillagerName(world, rng);
}

export function needsVillageName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed === '???') return true;
  if (/^仮面.*訪問者$/.test(trimmed) || /^覆面.*訪問者$/.test(trimmed)) return true;
  if (/^masked visitor$/i.test(trimmed)) return true;
  return trimmed.includes('名もなき') || trimmed.includes('名無し');
}

export function assignVillageName(world: World, originalName: string, rng: () => number = Math.random): string {
  const name = originalName.trim();
  if (!needsVillageName(name)) return name;
  return uniqueVillagerName(world, rng);
}

export function pickVillageNamer(world: World, targetId: VillagerId | null = null, rng: () => number = Math.random): Villager | null {
  const alive = [...world.villagers.values()].filter((v) => v.alive && v.id !== targetId);
  const named = alive.filter((v) => !needsVillageName(v.name));
  const candidates = named.length > 0 ? named : alive;
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)] ?? null;
}

export function addResidentHistory(
  world: World,
  villager: Villager,
  meta: Partial<Pick<ResidentHistoryEntry, 'origin' | 'llmBrain' | 'archetype' | 'joinedTerm' | 'originalName' | 'namedById' | 'namedByName'>> = {},
): ResidentHistoryEntry {
  const existing = world.residentHistory.find((h) => h.id === villager.id);
  if (existing) {
    existing.name = villager.name;
    existing.species = villager.species;
    if (meta.origin !== undefined) existing.origin = meta.origin;
    if (meta.joinedTerm !== undefined) existing.joinedTerm = meta.joinedTerm;
    if (meta.llmBrain !== undefined) existing.llmBrain = meta.llmBrain;
    if (meta.archetype !== undefined) existing.archetype = meta.archetype;
    if (meta.originalName !== undefined) existing.originalName = meta.originalName;
    if (meta.namedById !== undefined) existing.namedById = meta.namedById;
    if (meta.namedByName !== undefined) existing.namedByName = meta.namedByName;
    return existing;
  }
  const entry: ResidentHistoryEntry = {
    id: villager.id,
    name: villager.name,
    species: villager.species,
    origin: meta.origin ?? villager.origin,
    joinedTerm: meta.joinedTerm ?? world.term,
    llmBrain: meta.llmBrain ?? null,
    archetype: meta.archetype ?? null,
  };
  if (meta.originalName !== undefined) entry.originalName = meta.originalName;
  if (meta.namedById !== undefined) entry.namedById = meta.namedById;
  if (meta.namedByName !== undefined) entry.namedByName = meta.namedByName;
  world.residentHistory.push(entry);
  return entry;
}

export function ensureResidentHistory(world: World, resolveBrain?: (id: VillagerId) => string | null): void {
  normalizeGeneratedNames(world);
  for (const v of world.villagers.values()) {
    addResidentHistory(world, v, { joinedTerm: 0, llmBrain: resolveBrain?.(v.id) ?? null });
  }
}

export function nameExistingGenericIncidentVillagers(
  world: World,
  opts: { rng?: () => number; resolveBrain?: (id: VillagerId) => string | null } = {},
): VillagerNamingRecord[] {
  const rng = opts.rng ?? Math.random;
  const records: VillagerNamingRecord[] = [];
  for (const villager of world.villagers.values()) {
    const history = world.residentHistory.find((h) => h.id === villager.id);
    const origin = history?.origin ?? villager.origin;
    if (origin !== 'incident') continue;
    if (history?.originalName !== undefined) continue;
    if (!needsVillageName(villager.name)) continue;

    const namedBy = pickVillageNamer(world, villager.id, rng);
    if (!namedBy) continue;
    const originalName = villager.name;
    const assignedName = assignVillageName(world, originalName, rng);
    if (assignedName === originalName) continue;

    villager.name = assignedName;
    addResidentHistory(world, villager, {
      origin: 'incident',
      joinedTerm: history?.joinedTerm ?? world.term,
      llmBrain: opts.resolveBrain?.(villager.id) ?? history?.llmBrain ?? null,
      archetype: history?.archetype ?? '訪問者',
      originalName,
      namedById: namedBy.id,
      namedByName: namedBy.name,
    });
    records.push({
      villagerId: villager.id,
      originalName,
      assignedName,
      namedById: namedBy.id,
      namedByName: namedBy.name,
    });
  }
  return records;
}

export function connectNewVillager(world: World, villager: Villager, rng: () => number = Math.random): VillagerRelationship[] {
  const added: VillagerRelationship[] = [];
  for (const other of world.villagers.values()) {
    if (other.id === villager.id || !other.alive) continue;
    added.push(makeRelationship(villager, other, rng));
    added.push(makeRelationship(other, villager, rng));
  }
  world.relationships.push(...added);
  return added;
}

export function addVillagerActionLog(world: World, entry: VillagerActionEntry): void {
  world.villagerActionLog.push(entry);
  if (world.villagerActionLog.length > ACTION_LOG_CAP) {
    world.villagerActionLog.splice(0, world.villagerActionLog.length - ACTION_LOG_CAP);
  }
}

function makeRelationship(from: Villager, to: Villager, rng: () => number): VillagerRelationship {
  const f = from.persona.traits;
  const t = to.persona.traits;
  const warmth = (f.kindness + f.sociability + t.kindness + t.sociability) * 18;
  const friction = (f.aggression + t.aggression + Math.abs(f.ambition - t.ambition)) * 22;
  const affinity = Math.max(-100, Math.min(100, Math.round(warmth - friction + (rng() - 0.5) * 60)));
  return {
    from: from.id,
    to: to.id,
    affinity,
    hates: affinity <= REL_HATE_THRESHOLD,
    note: affinity <= REL_HATE_THRESHOLD ? `${from.name} は ${to.name} を警戒している` : affinity >= REL_LIKE_THRESHOLD ? `${from.name} は ${to.name} に好意的` : `${from.name} は ${to.name} を様子見している`,
  };
}

function pick(items: Archetype[], rng: () => number): Archetype {
  const total = items.reduce((s, item) => s + item.weight, 0);
  let n = rng() * total;
  for (const item of items) {
    n -= item.weight;
    if (n <= 0) return item;
  }
  return items[items.length - 1]!;
}

function jitterTraits(base: Partial<Record<PersonalityAxis, number>>, rng: () => number): Partial<Record<PersonalityAxis, number>> {
  const out: Partial<Record<PersonalityAxis, number>> = {};
  for (const [axis, value] of Object.entries(base) as [PersonalityAxis, number][]) {
    out[axis] = Math.max(0, Math.min(1, value + (rng() - 0.5) * 0.18));
  }
  return out;
}

function randomPos(world: World, rng: () => number): GridPos {
  return {
    x: Math.floor(rng() * world.config.gridWidth),
    y: Math.floor(rng() * world.config.gridHeight),
  };
}

function uniqueVillagerName(world: World, rng: () => number): string {
  const used = new Set([...world.villagers.values()].map((v) => v.name));
  for (let i = 0; i < 80; i += 1) {
    const candidate = generateVillagerName(rng);
    if (!used.has(candidate)) return candidate;
  }
  return `${FIRST[Math.floor(rng() * FIRST.length)]}${FIRST[Math.floor(rng() * FIRST.length)]}${LAST[Math.floor(rng() * LAST.length)]}`;
}

function normalizeGeneratedNames(world: World): void {
  const used = new Set([...world.villagers.values()].map((v) => v.name));
  for (const villager of world.villagers.values()) {
    const child = /の子\d+$/.test(villager.name);
    const newcomer = /^新入り\d+$/.test(villager.name);
    if (!child && !newcomer) continue;
    used.delete(villager.name);
    let next = generateVillagerName();
    for (let i = 0; i < 80 && used.has(next); i += 1) next = generateVillagerName();
    villager.name = next;
    used.add(next);
    const history = world.residentHistory.find((h) => h.id === villager.id);
    if (history) {
      history.name = next;
      history.origin = 'born';
      history.archetype = child ? '子供' : '新入り';
    } else {
      addResidentHistory(world, villager, { origin: 'born', archetype: child ? '子供' : '新入り' });
    }
  }
}
