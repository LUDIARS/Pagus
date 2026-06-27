// world スナップショットの永続化。出生・改変・評判などの揮発状態を
// data/runtime/world.json に保存し、再起動で復元する (gitignore)。
// 形式は JSON で確定 (SPEC §11): 糾弾プール/村の歴史と同じ持ち方に揃える。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  toWire,
  fromWire,
  WORLD_SNAPSHOT_VERSION,
  type World,
  type WorldSnapshot,
} from '@pagus/sim';
import { dataDir } from './load-data.js';

/** 復元したスナップショット (world + TermMachine の通し番号)。 */
export interface RestoredWorld {
  world: World;
  bornCount: number;
  incidentCount: number;
}

export class WorldStore {
  private readonly path: string;
  /** 書き込みを間引く最小間隔 (tick ごとの書き込みを避ける)。 */
  private readonly minIntervalMs: number;
  private lastSaveMs = 0;

  constructor(opts: { intervalMs?: number } = {}) {
    this.path = resolve(dataDir(), 'runtime', 'world.json');
    this.minIntervalMs = opts.intervalMs ?? 3000;
  }

  /** 保存済みスナップショットを復元する。無い/壊れている/版違いなら null。 */
  load(): RestoredWorld | null {
    let snap: WorldSnapshot;
    try {
      snap = JSON.parse(readFileSync(this.path, 'utf8')) as WorldSnapshot;
    } catch {
      return null; // 無ければ新規で始める (無言フォールバックではなく「保存なし」)
    }
    if (snap.version !== WORLD_SNAPSHOT_VERSION || typeof snap.world !== 'object' || snap.world === null) {
      console.warn(`[pagus] world.json の版が非互換 (v${snap.version}) のため破棄して新規開始`);
      return null;
    }
    return {
      world: fromWire(snap.world),
      bornCount: snap.bornCount ?? 0,
      incidentCount: snap.incidentCount ?? 0,
    };
  }

  /** 前回保存から minIntervalMs 以上経っていれば保存する (tick からの呼び出し用)。 */
  maybeSave(world: World, bornCount: number, incidentCount: number): void {
    const now = Date.now();
    if (now - this.lastSaveMs < this.minIntervalMs) return;
    this.save(world, bornCount, incidentCount);
  }

  /** 即時保存する (shutdown / 節目)。 */
  save(world: World, bornCount: number, incidentCount: number): void {
    const snap: WorldSnapshot = {
      version: WORLD_SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      world: toWire(world),
      bornCount,
      incidentCount,
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(snap, null, 2), 'utf8');
      this.lastSaveMs = Date.now();
    } catch (e) {
      console.error('[pagus] world スナップショット保存失敗', e);
    }
  }
}
