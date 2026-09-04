import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// vitest の既定 'forks' プールは Node 24 + tinypool 1.x で child_process IPC の
// deserialize がクラッシュする (Buffer.from が Object を受け取り ERR_INVALID_ARG_TYPE)。
// worker_threads ベースの 'threads' プールは別の IPC 経路を使い、この問題を回避する。
// node:sqlite を含む server テストも threads で問題なく動く。
// @pagus/sim の exports は Node 実行用に dist を指すため、事前 build 無しでは
// vite が解決できない。テストでは常に sim の TS ソースへ alias する。
export default defineConfig({
  resolve: {
    alias: {
      '@pagus/sim': fileURLToPath(new URL('../sim/src/index.ts', import.meta.url)),
    },
  },
  test: {
    pool: 'threads',
  },
});
