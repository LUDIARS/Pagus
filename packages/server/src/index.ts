// Pagus server エントリ。data からワールドを起こし、TermLoop と WS を配線する。
// v0.1 は思考を StubBrain で代替 (LLM 配線は v0.2)。

import { createWorld, TermMachine, StubBrain, EventDirector } from '@pagus/sim';
import { loadConfig, loadSeed } from './load-data.js';
import { TermLoop } from './term-loop.js';
import { GameWsServer } from './ws-server.js';

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`環境変数 ${name} が数値ではありません: ${v}`);
  return n;
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

  const brain = new StubBrain({ triggerAfter: numEnv('PAGUS_TRIGGER_AFTER', 6), damagePerStep: 4 });
  const director = new EventDirector({ maxRepsPerSegment: numEnv('PAGUS_REPS', 3) });
  const tm = new TermMachine(world, brain, { director });

  const port = numEnv('PAGUS_WS_PORT', 4310);
  const pace = { accel: numEnv('PAGUS_ACCEL', 600), minMs: numEnv('PAGUS_MIN_MS', 400) };
  const incidentStepMs = numEnv('PAGUS_INCIDENT_MS', 700);

  let loop: TermLoop;
  const ws = new GameWsServer(port, {
    onIncite: () => loop.incite(),
    onCalm: () => loop.calm(),
    onVote: (pick) => loop.vote(pick),
  });

  loop = new TermLoop(tm, brain, pace, incidentStepMs, {
    onSnapshot: (w) => ws.broadcastSnapshot(w),
    onLog: (phase, text) => ws.broadcastLog(phase, text),
  });
  loop.start();

  console.log(`[pagus] server ws://localhost:${port} | ${villagers.length} どうぶつ | accel x${pace.accel}`);
}

main();
