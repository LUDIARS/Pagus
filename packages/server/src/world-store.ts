import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  WORLD_SNAPSHOT_VERSION,
  fromWire,
  toWire,
  type World,
  type WorldSnapshot,
} from '@pagus/sim';
import { dataDir } from './load-data.js';
import { runtimeDb, type RuntimeDb } from './runtime-db.js';

const WORLD_ACTION_WINDOW = 100;

export interface RestoredWorld {
  world: World;
  bornCount: number;
  incidentCount: number;
  ruleCount: number;
}

export class WorldStore {
  private readonly legacyPath: string;
  private readonly db: RuntimeDb;
  private readonly minIntervalMs: number;
  private lastSaveMs = 0;

  constructor(opts: { intervalMs?: number; db?: RuntimeDb } = {}) {
    this.db = opts.db ?? runtimeDb();
    this.legacyPath = resolve(dataDir(), 'runtime', 'world.json');
    this.minIntervalMs = opts.intervalMs ?? 3000;
  }

  load(): RestoredWorld | null {
    const stored = this.db.getState<WorldSnapshot>('world');
    if (stored) return restoreSnapshot(this.withRecentActions(stored));

    const migrated = this.loadLegacyJson();
    if (!migrated) return null;
    const hydrated = this.withRecentActions(migrated);
    this.db.setState('world', withoutActionHistory(hydrated));
    return restoreSnapshot(hydrated);
  }

  maybeSave(world: World, bornCount: number, incidentCount: number, ruleCount: number): void {
    const now = Date.now();
    if (now - this.lastSaveMs < this.minIntervalMs) return;
    this.save(world, bornCount, incidentCount, ruleCount);
  }

  save(world: World, bornCount: number, incidentCount: number, ruleCount: number): void {
    const snap: WorldSnapshot = {
      version: WORLD_SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      world: toWire(world),
      bornCount,
      incidentCount,
      ruleCount,
    };
    try {
      this.db.setState('world', withoutActionHistory(snap));
      this.lastSaveMs = Date.now();
    } catch (e) {
      console.error('[pagus] world snapshot db save failed', e);
    }
  }

  private withRecentActions(snap: WorldSnapshot): WorldSnapshot {
    const snapshotActions = snap.world.villagerActionLog ?? [];
    if (this.db.villagerActionCount() === 0 && snapshotActions.length > 0) {
      this.db.addVillagerActions(snapshotActions);
    }
    return {
      ...snap,
      world: {
        ...snap.world,
        villagerActionLog: this.db.recentVillagerActions(WORLD_ACTION_WINDOW),
      },
    };
  }

  private loadLegacyJson(): WorldSnapshot | null {
    try {
      const snap = JSON.parse(readFileSync(this.legacyPath, 'utf8')) as WorldSnapshot;
      if (snap.version !== WORLD_SNAPSHOT_VERSION || typeof snap.world !== 'object' || snap.world === null) {
        console.warn(`[pagus] legacy world.json version mismatch (v${snap.version}); starting fresh`);
        return null;
      }
      return snap;
    } catch {
      return null;
    }
  }
}

function withoutActionHistory(snap: WorldSnapshot): WorldSnapshot {
  return {
    ...snap,
    world: {
      ...snap.world,
      villagerActionLog: [],
    },
  };
}

function restoreSnapshot(snap: WorldSnapshot): RestoredWorld | null {
  if (snap.version !== WORLD_SNAPSHOT_VERSION || typeof snap.world !== 'object' || snap.world === null) {
    console.warn(`[pagus] world snapshot version mismatch (v${snap.version}); starting fresh`);
    return null;
  }
  return {
    world: fromWire(snap.world),
    bornCount: snap.bornCount ?? 0,
    incidentCount: snap.incidentCount ?? 0,
    ruleCount: snap.ruleCount ?? 0,
  };
}
