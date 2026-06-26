// CLI 経由の LLM クライアント (= LUDIARS「API 不使用」規約を満たす)。
//
// Discutere の前例をミラーする:
//   - claude: `src/persona-engine/llm/claude-cli.ts` の `claude -p --output-format json`
//             + stdin プロンプト投入 + JSON エンベロープの .result 取り出し。
//   - codex : `src/persona-engine/worker-pool/spawner.ts` の
//             `BIN_BY_PROVIDER = { claude:'claude', codex:'codex' }` と
//             `[bin, '--model', model]` の引数形をミラー。standing worker と違い
//             Brain は 1-shot なので非対話の `exec` サブコマンドで stdin を処理する。
//
// 失敗系 (spawn 失敗 / 非ゼロ終了 / タイムアウト / 空出力 / JSON 破損) は全て throw。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LlmClient, LlmInvokeArgs } from './llm-client.js';

/** CLI バックエンドの種別。 */
export type CliProvider = 'claude' | 'codex';

/** Discutere spawner.ts と同じ provider→バイナリ対応。 */
const BIN_BY_PROVIDER: Record<CliProvider, string> = {
  claude: 'claude',
  codex: 'codex',
};

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * CLI の一過性失敗 (codex exec の hook 由来 exit 1 / レート / sandbox blip 等) を
 * 吸収するリトライ既定回数。env `PAGUS_CLI_RETRIES` で上書き可 (0 で無効)。
 * リトライは「同じ呼び出しをやり直す」だけで、設定不備の無言フォールバックではない。
 */
const DEFAULT_RETRIES = ((): number => {
  const v = Number(process.env.PAGUS_CLI_RETRIES);
  return Number.isInteger(v) && v >= 0 ? v : 2;
})();
/** リトライ間の基礎待機 ms (試行ごとに線形に伸ばす)。 */
const DEFAULT_RETRY_BACKOFF_MS = 500;

export interface CliLlmClientOptions {
  provider: CliProvider;
  /** 既定モデル ID (per-invoke の args.model が優先)。 */
  model: string;
  /** タイムアウト ms (default 120_000)。 */
  timeoutMs?: number;
  /** Windows で claude CLI が要する git-bash パス (未指定なら自動検出)。 */
  gitBashPath?: string;
  /** 一過性失敗のリトライ回数 (既定 PAGUS_CLI_RETRIES or 2)。 */
  retries?: number;
  /** リトライ間の基礎待機 ms (既定 500、試行ごとに線形)。 */
  retryBackoffMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * provider/model を固定した CLI クライアント。
 * backend ごとに 1 インスタンスを作って使い回す (LlmBrain がキャッシュ)。
 */
export class CliLlmClient implements LlmClient {
  private readonly provider: CliProvider;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly gitBashPath: string | undefined;
  private readonly retries: number;
  private readonly retryBackoffMs: number;

  constructor(opts: CliLlmClientOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.gitBashPath = opts.gitBashPath;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  /**
   * CLI を起動して応答を得る。一過性の transport 失敗 (非ゼロ終了/タイムアウト/
   * 空出力/spawn 失敗) は retries 回まで backoff 付きでやり直す。brain 側の parse
   * リトライは別レイヤ (JSON 不正用)。全試行失敗で throw (無言フォールバック禁止)。
   */
  async invoke(args: LlmInvokeArgs): Promise<{ text: string }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.invokeOnce(args);
      } catch (e) {
        lastErr = e;
        if (attempt < this.retries) {
          await delay(this.retryBackoffMs * (attempt + 1));
        }
      }
    }
    throw new Error(
      `${this.provider} cli が ${this.retries + 1} 回試行しても失敗: ${(lastErr as Error).message}`,
    );
  }

  private async invokeOnce(args: LlmInvokeArgs): Promise<{ text: string }> {
    const model = args.model ?? this.model;
    const timeoutMs = args.timeoutMs ?? this.timeoutMs;
    const prompt = composePrompt(args.system, args.prompt);

    // codex は stdout に preamble/ANSI を吐き、user プロンプトの echo に
    // スキーマ例の JSON が混じる → stdout からの抽出は不安定。
    // --output-last-message で「最終メッセージだけ」をファイルに書かせ、それを読む。
    if (this.provider === 'codex') {
      const dir = mkdtempSync(join(tmpdir(), 'pagus-codex-'));
      const outFile = join(dir, 'last.txt');
      try {
        await spawnCli({
          provider: this.provider,
          model,
          prompt,
          timeoutMs,
          gitBashPath: this.gitBashPath,
          outFile,
        });
        const text = readFileSync(outFile, 'utf8').trim();
        if (text.length === 0) throw new Error('codex cli の最終メッセージが空です');
        return { text };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const raw = await spawnCli({
      provider: this.provider,
      model,
      prompt,
      timeoutMs,
      gitBashPath: this.gitBashPath,
    });
    return { text: parseClaudeCliResult(raw) };
  }
}

/** system + user を 1 本のプロンプトに畳む (claude-cli.ts と同形)。 */
function composePrompt(system: string | undefined, user: string): string {
  if (!system) return user;
  return `[system]\n${system}\n\n[user]\n${user}`;
}

/** provider に応じた CLI 引数。codex は spawner.ts の `--model` 形をミラー。 */
function buildArgs(provider: CliProvider, model: string, outFile?: string): string[] {
  const bin = BIN_BY_PROVIDER[provider];
  if (provider === 'claude') {
    // -p (print) + JSON エンベロープで result を機械可読にする。
    const a = ['-p', '--output-format', 'json'];
    if (model) a.push('--model', model);
    return a;
  }
  // codex: 非対話 1-shot は `codex exec`。
  //   --skip-git-repo-check : 任意 cwd で動かす (trusted-dir 判定で落とさない)。
  //   -s read-only          : 1-shot 応答にシェル実行は不要 = 副作用を封じる。
  //   --output-last-message  : 最終メッセージだけを清書ファイルへ (stdout 抽出を避ける)。
  void bin;
  const a = ['exec', '--skip-git-repo-check', '-s', 'read-only', '--model', model];
  if (outFile) a.push('--output-last-message', outFile);
  return a;
}

interface SpawnCliArgs {
  provider: CliProvider;
  model: string;
  prompt: string;
  timeoutMs: number;
  gitBashPath?: string | undefined;
  /** codex の --output-last-message 出力先 (claude では未使用)。 */
  outFile?: string | undefined;
}

/** CLI を spawn し、stdout 全文を返す。失敗は reject。 */
function spawnCli(args: SpawnCliArgs): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const bin = BIN_BY_PROVIDER[args.provider];
    const cliArgs = buildArgs(args.provider, args.model, args.outFile);

    const env: NodeJS.ProcessEnv = { ...process.env };
    // claude CLI は Windows で git-bash を要する (feedback_claude_cli_windows_bash)。
    if (args.provider === 'claude') {
      if (args.gitBashPath) env.CLAUDE_CODE_GIT_BASH_PATH = args.gitBashPath;
      if (process.platform === 'win32' && !env.CLAUDE_CODE_GIT_BASH_PATH) {
        for (const c of [
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        ]) {
          if (existsSync(c)) {
            env.CLAUDE_CODE_GIT_BASH_PATH = c;
            break;
          }
        }
      }
    }
    // 親 (Lictor/Concordia) のラップ情報を子に持ち込まない。
    delete env.CONCORDIA_HOOK;
    delete env.LICTOR_PORT;
    delete env.LICTOR_PID;
    delete env.LICTOR_SESSION_ID;

    let child;
    try {
      child = spawn(bin, cliArgs, {
        env,
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    } catch (e) {
      reject(new Error(`${args.provider} cli spawn 失敗: ${(e as Error).message}`));
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
      reject(new Error(`${args.provider} cli タイムアウト (${args.timeoutMs} ms)`));
    }, args.timeoutMs);

    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      err += d.toString('utf8');
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${args.provider} cli error: ${e.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${args.provider} cli exit ${code}: ${err.slice(0, 200)}`));
        return;
      }
      const raw = out.trim();
      if (raw.length === 0) {
        reject(new Error(`${args.provider} cli の出力が空です`));
        return;
      }
      resolve(raw);
    });

    // プロンプトは stdin で渡す (feedback_claude_cli_long_prompt)。
    child.stdin.end(args.prompt);
  });
}

/** `claude -p --output-format json` の result エンベロープ (必要分のみ)。 */
interface ClaudeCliResultEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

/**
 * claude CLI の JSON stdout から本文 (.result) を取り出す。
 * 単一オブジェクト / イベント配列 (末尾 type:"result") の両形に対応。失敗は throw。
 */
export function parseClaudeCliResult(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`claude cli JSON parse 失敗: ${(e as Error).message}: ${raw.slice(0, 200)}`);
  }

  let env: ClaudeCliResultEnvelope | undefined;
  if (Array.isArray(parsed)) {
    const arr = parsed as ClaudeCliResultEnvelope[];
    env = arr.find((e) => e?.type === 'result') ?? arr[arr.length - 1];
  } else if (parsed && typeof parsed === 'object') {
    env = parsed as ClaudeCliResultEnvelope;
  }
  if (!env) throw new Error('claude cli JSON: result エンベロープ無し');
  if (env.is_error || (env.subtype && env.subtype !== 'success')) {
    throw new Error(
      `claude cli result error (${env.subtype ?? 'unknown'}): ${(env.result ?? '').slice(0, 200)}`,
    );
  }
  const text = typeof env.result === 'string' ? env.result.trim() : '';
  if (text.length === 0) throw new Error('claude cli JSON: result 本文が空です');
  return text;
}

/** codex CLI は平文を stdout に出す (claude のような JSON エンベロープを持たない)。 */
export function parseCodexResult(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) throw new Error('codex cli の出力が空です');
  return text;
}
