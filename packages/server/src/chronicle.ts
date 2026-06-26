// 村の歴史。節目の出来事 (事件/判決/改変/結婚/出産/日替わり/月替わり) を
// ゲーム内日付つきで記録し、data/runtime/chronicle.json に永続化する (gitignore)。
// 後から村の歩みをたどるための台帳。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { ChronicleEntry } from '@pagus/sim';
import { dataDir } from './load-data.js';

const CAP = 500;

export class Chronicle {
  private readonly path: string;
  private entries: ChronicleEntry[];

  constructor() {
    this.path = resolve(dataDir(), 'runtime', 'chronicle.json');
    this.entries = this.load();
  }

  /** 節目を 1 件追加して永続化。 */
  add(date: string, text: string): void {
    this.entries.push({ date, text });
    if (this.entries.length > CAP) this.entries = this.entries.slice(-CAP);
    this.save();
  }

  /** 直近 n 件。 */
  recent(n = 200): ChronicleEntry[] {
    return this.entries.slice(-n);
  }

  private load(): ChronicleEntry[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        return raw.filter(
          (e): e is ChronicleEntry =>
            typeof e === 'object' && e !== null && typeof (e as ChronicleEntry).text === 'string',
        );
      }
    } catch {
      /* 無ければ空で始める */
    }
    return [];
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.entries, null, 2), 'utf8');
    } catch {
      /* 永続化失敗は致命でない */
    }
  }
}
