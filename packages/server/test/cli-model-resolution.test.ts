import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnOneShot } from '@ludiars/one-shot';
import { CliLlmClient } from '../src/llm/cli-llm-client.js';

vi.mock(import('@ludiars/one-shot'), async (importOriginal) => ({
  ...await importOriginal(),
  spawnOneShot: vi.fn(),
}));

const spawn = vi.mocked(spawnOneShot);

function stubCli(): void {
  spawn.mockImplementation((_file: string, args?: readonly string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    child.stdin.once('finish', () => {
      const outputFileIndex = args?.indexOf('--output-last-message') ?? -1;
      if (outputFileIndex >= 0) {
        writeFileSync(args![outputFileIndex + 1]!, 'answer', 'utf8');
        child.stdout.write('completed');
      } else {
        child.stdout.write(JSON.stringify({ type: 'result', result: 'answer' }));
      }
      child.emit('close', 0);
    });
    return child as ReturnType<typeof spawnOneShot>;
  });
}

afterEach(() => {
  spawn.mockReset();
  vi.unstubAllEnvs();
});

describe('CliLlmClient model resolution', () => {
  it('passes role-map IDs to the CLI and reports the same ID to callers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pagus-model-roles-'));
    try {
      const roleMap = join(directory, 'model-roles.json');
      writeFileSync(roleMap, JSON.stringify({
        schemaVersion: 1,
        roles: { claude: { haiku: 'claude-haiku-test' }, codex: { sol: 'codex-sol-test' } },
      }));
      vi.stubEnv('LUDIARS_MODEL_ROLES_FILE', roleMap);
      vi.stubEnv('LUDIARS_ONESHOT_MODEL_HAIKU', undefined);
      vi.stubEnv('LUDIARS_ONESHOT_MODEL_SOL', undefined);
      stubCli();

      const claude = new CliLlmClient({ provider: 'claude', model: 'haiku', retries: 0 });
      const codex = new CliLlmClient({ provider: 'codex', model: 'sol', retries: 0 });
      await expect(claude.invoke({ prompt: 'test' })).resolves.toEqual({ text: 'answer', model: 'claude-haiku-test' });
      await expect(codex.invoke({ prompt: 'test' })).resolves.toEqual({ text: 'answer', model: 'codex-sol-test' });
      expect(spawn).toHaveBeenNthCalledWith(1, 'claude', ['-p', '--output-format', 'json', '--model', 'claude-haiku-test'], expect.any(Object));
      expect(spawn).toHaveBeenNthCalledWith(2, 'codex', [
        'exec', '--skip-git-repo-check', '-s', 'read-only', '--model', 'codex-sol-test',
        '--output-last-message', expect.any(String),
      ], expect.any(Object));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves an explicitly selected model ID and prioritizes overrides', async () => {
    stubCli();
    const client = new CliLlmClient({ provider: 'codex', model: 'codex-configured-test', retries: 0 });
    await expect(client.invoke({ prompt: 'test' })).resolves.toMatchObject({ model: 'codex-configured-test' });
    await expect(client.invoke({ prompt: 'test', model: 'codex-override-test' })).resolves.toMatchObject({ model: 'codex-override-test' });
    expect(spawn.mock.calls.map(([, args]) => args?.[5])).toEqual(['codex-configured-test', 'codex-override-test']);
  });
});
