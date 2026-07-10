import type { UserFaithEntry, VillagerRelationship, World } from '@pagus/sim';
import { runtimeDb, type RuntimeDb } from './runtime-db.js';

export interface ArchivedResidentStateCount {
  relationships: number;
  userFaith: number;
}

/**
 * Keeps relationship and faith working sets limited to living residents.
 * SQLite remains the authority for state belonging to residents who left play.
 */
export class InactiveResidentStore {
  constructor(private readonly db: RuntimeDb = runtimeDb()) {}

  archiveInactive(world: World): ArchivedResidentStateCount {
    const activeIds = livingResidentIds(world);
    const archivedRelationships = world.relationships.filter(
      (entry) => !activeIds.has(entry.from) || !activeIds.has(entry.to),
    );
    const archivedFaith = world.userFaith.filter((entry) => !activeIds.has(entry.villagerId));

    this.db.archiveRelationships(archivedRelationships);
    this.db.archiveUserFaith(archivedFaith);

    if (archivedRelationships.length > 0) {
      world.relationships = world.relationships.filter(
        (entry) => activeIds.has(entry.from) && activeIds.has(entry.to),
      );
    }
    if (archivedFaith.length > 0) {
      world.userFaith = world.userFaith.filter((entry) => activeIds.has(entry.villagerId));
    }
    return {
      relationships: archivedRelationships.length,
      userFaith: archivedFaith.length,
    };
  }

  restoreForRevivedResident(world: World, villagerId: string): ArchivedResidentStateCount {
    if (world.villagers.get(villagerId)?.alive !== true) return { relationships: 0, userFaith: 0 };
    const activeIds = livingResidentIds(world);
    const relationshipKeys = new Set(world.relationships.map(relationshipKey));
    const restoredRelationships = this.db
      .archivedRelationshipsFor(villagerId)
      .filter((entry) => activeIds.has(entry.from) && activeIds.has(entry.to))
      .filter((entry) => !relationshipKeys.has(relationshipKey(entry)));
    world.relationships.push(...restoredRelationships);

    const faithKeys = new Set(world.userFaith.map(userFaithKey));
    const restoredFaith = this.db
      .archivedUserFaithFor(villagerId)
      .filter((entry) => !faithKeys.has(userFaithKey(entry)));
    world.userFaith.push(...restoredFaith);

    return {
      relationships: restoredRelationships.length,
      userFaith: restoredFaith.length,
    };
  }
}

function livingResidentIds(world: World): Set<string> {
  return new Set([...world.villagers.values()].filter((villager) => villager.alive).map((villager) => villager.id));
}

function relationshipKey(entry: VillagerRelationship): string {
  return `${entry.from}\u0000${entry.to}`;
}

function userFaithKey(entry: UserFaithEntry): string {
  return `${entry.villagerId}\u0000${entry.userId}`;
}
