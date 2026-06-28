// セッションログ。ループの各イベント (起承転結の narration) を
//   1) stdout へ整形表示 (稼働中に住民の動きを目視する)
//   2) JSONL ファイルへ追記 (後から振り返る)
// の 2 系統へ流す。描画にもゲームロジックにも依存しない純粋な I/O。
//
// 設定 (PagusConfig.server.{logStdout,logFile,logDir}) は index がコンストラクタ注入する。
// 自前で env を読まない。

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import type { World } from '@pagus/sim';

const here = dirname(fileURLToPath(import.meta.url));

/** SessionLog の設定 (PagusConfig.server 相当)。 */
export interface SessionLogConfig {
  /** stdout エコー (既定 on)。 */
  logStdout: boolean;
  /** JSONL 永続化 (既定 on)。 */
  logFile: boolean;
  /** 出力先ディレクトリ。空文字は既定 (<repo>/logs)。 */
  logDir: string;
}

/** 既定 (旧 env 既定と一致)。 */
export const DEFAULT_SESSION_LOG_CONFIG: SessionLogConfig = {
  logStdout: true,
  logFile: true,
  logDir: '',
};

function resolveLogDir(dir: string): string {
  if (dir.length > 0) return dir;
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

  constructor(config: SessionLogConfig = DEFAULT_SESSION_LOG_CONFIG) {
    this.toStdout = config.logStdout;
    if (config.logFile) {
      const dir = resolveLogDir(config.logDir);
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
