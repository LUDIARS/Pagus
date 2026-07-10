import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChronicleEntry, ChronicleKind } from '@pagus/sim';
import { dataDir } from './load-data.js';
import { runtimeDb, type RuntimeDb } from './runtime-db.js';

const CAP = 500;

export class Chronicle {
  private readonly legacyPath: string;
  private readonly db: RuntimeDb;

  constructor(db: RuntimeDb = runtimeDb(), legacyPath = resolve(dataDir(), 'runtime', 'chronicle.json')) {
    this.db = db;
    this.legacyPath = legacyPath;
    this.migrateLegacy();
  }

  add(date: string, text: string, kind?: ChronicleKind, extra: Omit<ChronicleEntry, 'date' | 'text' | 'kind'> = {}): void {
    const entry: ChronicleEntry = kind === undefined ? { date, text, ...extra } : { date, text, kind, ...extra };
    this.db.addChronicle(entry);
  }

  recent(n = 200): ChronicleEntry[] {
    return this.db.recentChronicle(Math.min(n, CAP));
  }

  hasEvent(eventId: string): boolean {
    return this.db.hasChronicleEvent(eventId);
  }

  private migrateLegacy(): void {
    if (this.db.chronicleCount() > 0) return;
    const legacy = this.loadLegacyJson();
    if (legacy.length > 0) this.db.replaceChronicle(legacy);
  }

  private loadLegacyJson(): ChronicleEntry[] {
    try {
      const raw = JSON.parse(readFileSync(this.legacyPath, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((e): e is ChronicleEntry => typeof e === 'object' && e !== null && typeof (e as ChronicleEntry).text === 'string')
        .slice(-CAP);
    } catch {
      return [];
    }
  }
}
