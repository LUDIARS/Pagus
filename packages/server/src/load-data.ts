// data/ アンカーから world.config と どうぶつ seed を読む。
// 設定不備は即エラー (無言フォールバック禁止 — RULE_CODE §7.1)。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createVillager, validateArcs, type WorldConfig, type Villager, type ArcRule } from '@pagus/sim';
import type { VillagerSeed } from '@pagus/sim';

const here = dirname(fileURLToPath(import.meta.url));

/** リポ root の data/。PAGUS_DATA_DIR で上書き可。 */
export function dataDir(): string {
  const env = process.env.PAGUS_DATA_DIR;
  if (env && env.length > 0) return env;
  // packages/server/{src|dist} → ../../../data
  return resolve(here, '../../../data');
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`必要なデータファイルが読めません: ${path}`, { cause });
  }
  return JSON.parse(text);
}

export function loadConfig(): WorldConfig {
  const cfg = readJson(resolve(dataDir(), 'world.config.json')) as Partial<WorldConfig>;
  const required: Array<keyof WorldConfig> = [
    'gridWidth',
    'gridHeight',
    'segmentsPerDay',
    'damageThreshold',
    'trialWinningScore',
  ];
  for (const k of required) {
    if (typeof cfg[k] !== 'number') throw new Error(`world.config.json の ${k} が不正です`);
  }
  return cfg as WorldConfig;
}

/**
 * 事件アークの派生表 (§v1.4-B, data/incident-arcs.json)。ファイルが無ければ null
 * (= sim の DEFAULT_ARCS を使う正規の既定分岐)。内容不正は throw (無言フォールバック禁止)。
 */
export function loadIncidentArcs(): ArcRule[] | null {
  const path = resolve(dataDir(), 'incident-arcs.json');
  if (!existsSync(path)) return null;
  return validateArcs(readJson(path));
}

export function loadSeed(): Villager[] {
  const raw = readJson(resolve(dataDir(), 'villagers/seed.json'));
  if (!Array.isArray(raw)) throw new Error('villagers/seed.json は配列である必要があります');
  return (raw as VillagerSeed[]).map((s) => createVillager(s));
}
