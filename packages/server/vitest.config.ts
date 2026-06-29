import { defineConfig } from 'vitest/config';

// vitest の既定 'forks' プールは Node 24 + tinypool 1.x で child_process IPC の
// deserialize がクラッシュする (Buffer.from が Object を受け取り ERR_INVALID_ARG_TYPE)。
// worker_threads ベースの 'threads' プールは別の IPC 経路を使い、この問題を回避する。
// node:sqlite を含む server テストも threads で問題なく動く。
export default defineConfig({
  test: {
    pool: 'threads',
  },
});
