// Pagus server エントリ。data からワールドを起こし、TermLoop と WS を配線する。
// 思考は PAGUS_BRAIN で切替: 'stub'(既定/決定的) | 'llm'(実 LLM = claude/codex CLI)。

import { createWorld, TermMachine, StubBrain, StubWorldBrain, EventDirector, type WorldBrain, type LlmInfo } from '@pagus/sim';
import { loadConfig, loadSeed } from './load-data.js';
import { TermLoop, type LoopBrain } from './term-loop.js';
import { GameWsServer } from './ws-server.js';
import { BackendRegistry, LlmBrain, LlmWorldBrain, CliLlmClient, DEFAULT_CAST, DEFAULT_STRONG, GPT_BACKEND } from './llm/index.js';
import { createServer } from 'node:http';
import { SessionLog } from './session-log.js';
import { TrialNarrator } from './trial-narrator.js';
import { Chronicle } from './chronicle.js';
import { WorldStore } from './world-store.js';
import { PushService } from './push-service.js';
import { createRequestListener } from './http-api.js';

/** 村の歴史に残す「節目」のログか判定する。 */
function isMilestone(text: string): boolean {
  return (
    /^[⚡✦💍👶📅]/.test(text) ||
    text.startsWith('—— 審判') ||
    text.startsWith('判決') ||
    text.startsWith('🕊') ||
    text.startsWith('──') ||
    text.includes('月がかわった')
  );
}

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
function selectBrains(): { brain: LoopBrain; worldBrain: WorldBrain; registry: BackendRegistry | null } {
  const mode = process.env.PAGUS_BRAIN ?? 'stub';
  if (mode === 'stub') {
    return {
      brain: new StubBrain({ triggerAfter: numEnv('PAGUS_TRIGGER_AFTER', 6), damagePerStep: 4 }),
      worldBrain: new StubWorldBrain(),
      registry: null,
    };
  }
  if (mode === 'llm') {
    // codex(gpt-5.5) は一過性 exit 1 が安定するまで既定オフ。PAGUS_ENABLE_CODEX=1 で合流。
    const enableCodex = (process.env.PAGUS_ENABLE_CODEX ?? '') === '1';
    const cast = enableCodex ? [...DEFAULT_CAST, GPT_BACKEND] : DEFAULT_CAST;
    const strong = enableCodex ? [...DEFAULT_STRONG, GPT_BACKEND] : DEFAULT_STRONG;
    const registry = new BackendRegistry({ cast, strong });
    return { brain: new LlmBrain(registry), worldBrain: new LlmWorldBrain(registry), registry };
  }
  throw new Error(`環境変数 PAGUS_BRAIN は 'stub' | 'llm' のいずれか: ${mode}`);
}

/** UI 表示用の LLM 構成を作る。 */
function buildLlmInfo(registry: BackendRegistry | null, villagers: { id: string }[]): LlmInfo {
  if (!registry) return { mode: 'stub', backends: [], strong: [], assignments: {} };
  return {
    mode: 'llm',
    backends: registry.backends.map((b) => ({ id: b.id, provider: b.provider, model: b.model })),
    strong: registry.strongBackends.map((b) => b.id),
    assignments: Object.fromEntries(villagers.map((v) => [v.id, registry.assign(v.id).id])),
  };
}

function main(): void {
  const config = loadConfig();

  // world スナップショット (data/runtime/world.json) があれば復元。PAGUS_FRESH=1 で無視して新規開始。
  const store = new WorldStore();
  const fresh = (process.env.PAGUS_FRESH ?? '') === '1';
  const restored = fresh ? null : store.load();

  let world;
  if (restored) {
    world = restored.world;
    console.log(`[pagus] world.json を復元 (${world.calendar.month}月${world.calendar.dayOfMonth}日 / ${world.villagers.size} どうぶつ)`);
  } else {
    // ゲーム内月のテーマは実カレンダーに連動 (新規開始時のみ)。
    const now = new Date();
    world = createWorld(loadSeed(), config, { year: now.getFullYear(), month: now.getMonth() + 1 });
  }
  const villagers = [...world.villagers.values()];

  const { brain, worldBrain, registry } = selectBrains();
  const llmInfo = buildLlmInfo(registry, villagers);
  const director = new EventDirector({ maxRepsPerSegment: numEnv('PAGUS_REPS', 3) });
  const tm = new TermMachine(world, brain, {
    director,
    worldBrain,
    reconcileChance: numEnv('PAGUS_RECONCILE', 0.15), // 事件が和解で収まる基礎確率
    secondaryChance: numEnv('PAGUS_SECONDARY', 0.18), // 二次被害の確率
    stressFizzleK: numEnv('PAGUS_STRESS_K', 0.06), // ストレス耐性で嫌がらせを受け流す効き
    marriageChance: numEnv('PAGUS_MARRIAGE', 0.12), // 日末の結婚確率
    birthChance: numEnv('PAGUS_BIRTH', 0.1), // 日末の出産確率
    bornCount: restored?.bornCount ?? 0, // 出生 id の通し番号を引き継ぐ
  });

  const port = numEnv('PAGUS_WS_PORT', 4310);
  const pace = { accel: numEnv('PAGUS_ACCEL', 600), minMs: numEnv('PAGUS_MIN_MS', 400) };
  const incidentStepMs = numEnv('PAGUS_INCIDENT_MS', 700);

  // 住民の動きを stdout へ流しつつ JSONL へ永続化する (後から振り返れる)。
  const sessionLog = new SessionLog();

  // 裁判の糾弾セリフ: llm モードでは Haiku 生成 (65%) + レパートリー蓄積。
  const llmMode = (process.env.PAGUS_BRAIN ?? 'stub') === 'llm';
  const narrator = new TrialNarrator(
    llmMode ? { client: new CliLlmClient({ provider: 'claude', model: 'claude-haiku-4-5' }) } : {},
  );

  // 村の歴史 (節目を記録・永続化)。
  const chronicle = new Chronicle();

  // WebPush 通知 (§4.8)。VAPID 未設定なら無効 (PAGUS_PUSH=1 + 鍵で有効化)。
  const push = new PushService();

  let loop: TermLoop;
  // HTTP API (push 購読 / 通知経由の投票) と WS を同一ポートに相乗りさせる。
  const httpServer = createServer(
    createRequestListener({ push, onVote: (pick, userId) => loop.vote(pick, userId) }),
  );
  const ws = new GameWsServer(httpServer, {
    onIncite: () => loop.incite(),
    onCalm: () => loop.calm(),
    onVote: (pick, userId) => loop.vote(pick, userId),
  });
  ws.setLlmInfo(llmInfo);
  ws.updateChronicle(chronicle.recent()); // 既存の歴史を初期配信対象に。

  loop = new TermLoop(tm, brain, pace, incidentStepMs, {
    onSnapshot: (w) => {
      ws.broadcastSnapshot(w);
      sessionLog.snapshot(w);
      store.maybeSave(w, tm.getBornCount()); // 揮発状態 (出生/改変/評判) を間引いて永続化
    },
    onLog: (phase, text) => {
      ws.broadcastLog(phase, text);
      sessionLog.line(phase, text);
      if (isMilestone(text)) {
        const cal = tm.world.calendar;
        chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, text);
        ws.updateChronicle(chronicle.recent());
      }
    },
    onTrialOpen: (w) => {
      const incidentId = w.incident?.id;
      if (!incidentId) return;
      // 投票が要る局面 → 接続を閉じている端末へも通知して投票を促す (§4.8)。
      const desc = w.incident?.description;
      void push.notifyAll({
        title: 'Pagus — 審判の時',
        body: desc ? `「${desc}」の裁判。投票で運命を決めよう` : '裁判がはじまった。投票しよう',
        url: '/',
      });
      void narrator
        .linesFor(w)
        .then((lines) => {
          if (lines.length > 0) ws.broadcastTrialLines(incidentId, lines);
        })
        .catch((e) => console.error('[pagus] 糾弾生成エラー', e));
    },
  });
  loop.start();

  // Ctrl-C でループを止めログを flush してから抜ける。
  const shutdown = (): void => {
    loop.stop();
    store.save(tm.world, tm.getBornCount()); // 終了時は確実に最新を書き出す
    sessionLog.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  httpServer.listen(port);

  const brainLabel = process.env.PAGUS_BRAIN ?? 'stub';
  console.log(`[pagus] server ws://localhost:${port} (+HTTP API) | ${villagers.length} どうぶつ | brain=${brainLabel} | accel x${pace.accel}`);
  if (sessionLog.file) console.log(`[pagus] session log → ${sessionLog.file}`);
}

main();
