// Pagus server エントリ。data からワールドを起こし、TermLoop と WS を配線する。
// 思考は PAGUS_BRAIN で切替: 'stub'(既定/決定的) | 'llm'(実 LLM = claude/codex CLI)。

import { createWorld, TermMachine, StubBrain, StubWorldBrain, EventDirector, type WorldBrain } from '@pagus/sim';
import { loadConfig, loadSeed } from './load-data.js';
import { TermLoop, type LoopBrain } from './term-loop.js';
import { GameWsServer } from './ws-server.js';
import { BackendRegistry, LlmBrain, LlmWorldBrain } from './llm/index.js';
import { SessionLog } from './session-log.js';

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`環境変数 ${name} が数値ではありません: ${v}`);
  return n;
}

/**
 * PAGUS_BRAIN で 個体 Brain と 世界側 WorldBrain を一括で選ぶ (既定 'stub')。
 * 'llm' は claude/codex CLI 駆動。両者で同一 BackendRegistry を共有する。
 * 不正値は無言フォールバックせず即エラー (RULE_CODE §7.1)。
 */
function selectBrains(): { brain: LoopBrain; worldBrain: WorldBrain } {
  const mode = process.env.PAGUS_BRAIN ?? 'stub';
  if (mode === 'stub') {
    return {
      brain: new StubBrain({ triggerAfter: numEnv('PAGUS_TRIGGER_AFTER', 6), damagePerStep: 4 }),
      worldBrain: new StubWorldBrain(),
    };
  }
  if (mode === 'llm') {
    const registry = new BackendRegistry();
    return { brain: new LlmBrain(registry), worldBrain: new LlmWorldBrain(registry) };
  }
  throw new Error(`環境変数 PAGUS_BRAIN は 'stub' | 'llm' のいずれか: ${mode}`);
}

function main(): void {
  const config = loadConfig();
  const villagers = loadSeed();

  // ゲーム内月のテーマは実カレンダーに連動。
  const now = new Date();
  const world = createWorld(villagers, config, {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  });

  const { brain, worldBrain } = selectBrains();
  const director = new EventDirector({ maxRepsPerSegment: numEnv('PAGUS_REPS', 3) });
  const tm = new TermMachine(world, brain, {
    director,
    worldBrain,
    reconcileChance: numEnv('PAGUS_RECONCILE', 0.15), // 事件が和解で収まる基礎確率
    secondaryChance: numEnv('PAGUS_SECONDARY', 0.18), // 二次被害の確率
  });

  const port = numEnv('PAGUS_WS_PORT', 4310);
  const pace = { accel: numEnv('PAGUS_ACCEL', 600), minMs: numEnv('PAGUS_MIN_MS', 400) };
  const incidentStepMs = numEnv('PAGUS_INCIDENT_MS', 700);

  // 住民の動きを stdout へ流しつつ JSONL へ永続化する (後から振り返れる)。
  const sessionLog = new SessionLog();

  let loop: TermLoop;
  const ws = new GameWsServer(port, {
    onIncite: () => loop.incite(),
    onCalm: () => loop.calm(),
    onVote: (pick) => loop.vote(pick),
  });

  loop = new TermLoop(tm, brain, pace, incidentStepMs, {
    onSnapshot: (w) => {
      ws.broadcastSnapshot(w);
      sessionLog.snapshot(w);
    },
    onLog: (phase, text) => {
      ws.broadcastLog(phase, text);
      sessionLog.line(phase, text);
    },
  });
  loop.start();

  // Ctrl-C でループを止めログを flush してから抜ける。
  const shutdown = (): void => {
    loop.stop();
    sessionLog.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const brainLabel = process.env.PAGUS_BRAIN ?? 'stub';
  console.log(`[pagus] server ws://localhost:${port} | ${villagers.length} どうぶつ | brain=${brainLabel} | accel x${pace.accel}`);
  if (sessionLog.file) console.log(`[pagus] session log → ${sessionLog.file}`);
}

main();
