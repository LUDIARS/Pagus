// 糾弾セリフのレパートリー (永続プール)。
// 裁判の糾弾は「65% は Haiku が事件文脈で新規生成して保存 / 35% は既存プールから再利用」。
// プールは回すほど増える。data/runtime/denunciations.json に永続化 (gitignore)。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { dataDir } from './load-data.js';

/** 空プールを避けるための種セリフ (テーマパック §v1.4-D から差し替え可)。 */
const SEED: string[] = [
  '恥を知れ！',
  '許せない！',
  '万死に値する！',
  'よくもやったな！',
  '弁明は無用だ！',
  '村の面汚しめ！',
  'お前の罪を数えろ！',
  '二度と顔を見せるな！',
];

export interface RepertoireOptions {
  /** 永続ファイル名 (data/runtime/ 配下)。テーマパックごとに分けてトーン混線を防ぐ。 */
  file?: string;
  /** 種セリフ (テーマパックの denounceSeeds)。 */
  seeds?: string[];
}

export class Repertoire {
  private readonly path: string;
  private pool: string[];
  private readonly seen: Set<string>;
  private readonly seeds: string[];

  constructor(opts: RepertoireOptions = {}) {
    this.path = resolve(dataDir(), 'runtime', opts.file ?? 'denunciations.json');
    this.seeds = opts.seeds && opts.seeds.length > 0 ? opts.seeds : SEED;
    this.pool = this.load();
    this.seen = new Set(this.pool);
  }

  /** プール件数 (ログ用)。 */
  get size(): number {
    return this.pool.length;
  }

  /** プールから 1 つ無作為に返す。 */
  pick(): string {
    const i = Math.floor(Math.random() * this.pool.length);
    return this.pool[i] ?? this.seeds[0] ?? SEED[0]!;
  }

  /** 新セリフを追加して永続化 (重複は弾く)。 */
  add(line: string): void {
    const t = line.trim();
    if (t.length === 0 || this.seen.has(t)) return;
    this.seen.add(t);
    this.pool.push(t);
    this.save();
  }

  private load(): string[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        const lines = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
        if (lines.length > 0) return lines;
      }
    } catch {
      /* 無ければ種で始める */
    }
    return [...this.seeds];
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.pool, null, 2), 'utf8');
    } catch {
      /* 永続化失敗は致命でない (再利用は in-memory で続く) */
    }
  }
}
