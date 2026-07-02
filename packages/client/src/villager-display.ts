import type { ResidentHistoryEntry, Villager, VillagerId, WireWorld } from '@pagus/sim';

export function villagerDisplayName(world: WireWorld, villager: Pick<Villager, 'id' | 'name' | 'origin' | 'madman'>): string {
  const badge = villagerBadge(world, villager);
  const mad = villager.madman ? '😈' : '';
  return `${mad}${badge}${villager.name}`;
}

export function villagerNameMap(world: WireWorld): Map<VillagerId, string> {
  return new Map(world.villagers.map((v) => [v.id, villagerDisplayName(world, v)]));
}

export function residentHistoryDisplayName(world: WireWorld, history: ResidentHistoryEntry): string {
  const villager = world.villagers.find((v) => v.id === history.id);
  if (villager) return villagerDisplayName(world, villager);
  const badge = isNewcomer(history) ? '🧳' : isChild(history) ? '👶' : history.origin === 'incident' ? '⚡' : '';
  return `${badge}${history.name}`;
}

function villagerBadge(world: WireWorld, villager: Pick<Villager, 'id' | 'origin'>): string {
  const history = world.residentHistory.find((h) => h.id === villager.id);
  if (isNewcomer(history)) return '🧳';
  if (isChild(history)) return '👶';
  if (villager.origin === 'incident') return '⚡';
  return '';
}

function isNewcomer(history: ResidentHistoryEntry | undefined): boolean {
  return history?.origin === 'freeGacha' || history?.origin === 'karmaGacha' || history?.archetype === '新入り';
}

function isChild(history: ResidentHistoryEntry | undefined): boolean {
  return history?.archetype === '子供' || (history?.origin === 'born' && history.joinedTerm > 0);
}
