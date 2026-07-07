import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChronicleEntry, ChronicleKind } from '@pagus/sim';
import { dataDir } from './load-data.js';
import { runtimeDb } from './runtime-db.js';

const CAP = 500;

export class Chronicle {
  private readonly legacyPath: string;
  private readonly db = runtimeDb();
  private entries: ChronicleEntry[];

  constructor() {
    this.legacyPath = resolve(dataDir(), 'runtime', 'chronicle.json');
    this.entries = this.load();
  }

  add(date: string, text: string, kind?: ChronicleKind, extra: Omit<ChronicleEntry, 'date' | 'text' | 'kind'> = {}): void {
    const entry: ChronicleEntry = kind === undefined ? { date, text, ...extra } : { date, text, kind, ...extra };
    this.entries.push(entry);
    if (this.entries.length > CAP) this.entries = this.entries.slice(-CAP);
    this.db.addChronicle(entry);
  }

  recent(n = 200): ChronicleEntry[] {
    return this.entries.slice(-n);
  }

  private load(): ChronicleEntry[] {
    const stored = this.db.recentChronicle(CAP);
    if (stored.length > 0 || this.db.chronicleCount() > 0) return stored;

    const legacy = this.loadLegacyJson();
    if (legacy.length > 0) this.db.replaceChronicle(legacy);
    return legacy;
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
