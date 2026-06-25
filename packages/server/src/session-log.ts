// セッションログ。ループの各イベント (起承転結の narration) を
//   1) stdout へ整形表示 (稼働中に住民の動きを目視する)
//   2) JSONL ファイルへ追記 (後から振り返る)
// の 2 系統へ流す。描画にもゲームロジックにも依存しない純粋な I/O。
//
// env:
//   PAGUS_LOG_STDOUT  '0' で stdout エコーを止める (既定 on)
//   PAGUS_LOG_FILE    '0' でファイル永続化を止める (既定 on)
//   PAGUS_LOG_DIR     出力先ディレクトリ (既定 <repo>/logs)

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import type { World } from '@pagus/sim';

const here = dirname(fileURLToPath(import.meta.url));

/** env フラグ。未設定は既定 on、'0'/'false' で off。 */
function flag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v !== '0' && v.toLowerCase() !== 'false';
}

function logDir(): string {
  const env = process.env.PAGUS_LOG_DIR;
  if (env && env.length > 0) return env;
  // packages/server/{src|dist} → ../../../logs
  return resolve(here, '../../../logs');
}

/** ファイル名向けの安定タイムスタンプ (YYYYMMDD-HHMMSS)。 */
function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 起承転結のフェーズを読みやすい記号に。 */
const PHASE_MARK: Record<World['phase'], string> = {
  idle: '·',
  kisho: '起',
  sho: '承',
  ten: '転',
  ketsu: '結',
  reform: '改',
  advance: '夜',
};

export class SessionLog {
  private readonly toStdout: boolean;
  private readonly stream: WriteStream | null;
  private readonly path: string | null;
  private lastPhase: World['phase'] | null = null;

  constructor() {
    this.toStdout = flag('PAGUS_LOG_STDOUT', true);
    if (flag('PAGUS_LOG_FILE', true)) {
      const dir = logDir();
      mkdirSync(dir, { recursive: true });
      this.path = join(dir, `pagus-${stamp(new Date())}.jsonl`);
      this.stream = createWriteStream(this.path, { flags: 'a' });
    } else {
      this.stream = null;
      this.path = null;
    }
  }

  /** 永続化先 (無効なら null)。起動ログ用。 */
  get file(): string | null {
    return this.path;
  }

  /** ループの 1 ログ行。stdout エコー + JSONL 追記。 */
  line(phase: World['phase'], text: string): void {
    const now = new Date();
    if (this.toStdout) {
      const t = now.toTimeString().slice(0, 8);
      process.stdout.write(`[${t}][${PHASE_MARK[phase]}] ${text}\n`);
    }
    this.write({ t: 'log', ts: now.toISOString(), phase, text });
  }

  /**
   * スナップショットの要約をフェーズ遷移時だけ記録する (毎 tick の洪水を避ける)。
   * 後から「いつ村がどう傾いたか」を辿るための骨組み。
   */
  snapshot(world: World): void {
    if (world.phase === this.lastPhase) return;
    this.lastPhase = world.phase;
    const alive = [...world.villagers.values()].filter((v) => v.alive).length;
    this.write({
      t: 'snapshot',
      ts: new Date().toISOString(),
      phase: world.phase,
      day: world.calendar.dayOfMonth,
      month: world.calendar.month,
      segment: world.calendar.segment,
      alive,
      reputation: world.reputation,
    });
  }

  close(): void {
    this.stream?.end();
  }

  private write(record: Record<string, unknown>): void {
    this.stream?.write(`${JSON.stringify(record)}\n`);
  }
}
