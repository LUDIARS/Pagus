// Pagus server エントリ。data からワールドを起こし、TermLoop と WS を配線する。
// 思考は PAGUS_BRAIN で切替: 'stub'(既定/決定的) | 'llm'(実 LLM = claude/codex CLI)。

import { createWorld, TermMachine, StubBrain, StubWorldBrain, EventDirector, pickVillageRules, type Brain, type WorldBrain, type LlmInfo, type PlayerActionEntry, type ChronicleKind } from '@pagus/sim';
import { loadConfig, loadSeed } from './load-data.js';
import { TermLoop } from './term-loop.js';
import { GameWsServer } from './ws-server.js';
import { PlayerState } from './player-state.js';
import { BackendRegistry, LlmBrain, LlmWorldBrain, CliLlmClient, CostLog, DEFAULT_CAST, DEFAULT_STRONG, GPT_BACKEND, type CostSink } from './llm/index.js';
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
    /^[⚡✦💍👶📅📜]/.test(text) ||
    text.startsWith('—— 審判') ||
    text.startsWith('判決') ||
    text.startsWith('🕊') ||
    text.startsWith('⚖') ||
    text.startsWith('──') ||
    text.includes('月がかわった')
  );
}

/**
 * 節目ログの種別を 1 箇所で判定する (§2.2 履歴の構造化)。
 * クライアントの絵文字 startsWith 判定を server 側へ集約し、ChronicleEntry.kind を埋める。
 */
function classifyKind(text: string): ChronicleKind {
  const t = text.trimStart();
  if (t.startsWith('⚡')) return 'incident';
  if (t.startsWith('🕊')) return 'reconcile';
  if (t.startsWith('⚖')) return 'sanction';
  if (t.startsWith('✦')) return 'reform';
  if (t.startsWith('💍')) return 'marriage';
  if (t.startsWith('👶')) return 'birth';
  if (t.startsWith('📜')) return 'rule';
  if (t.startsWith('📅')) return 'holiday';
  if (t.startsWith('—— 審判')) return 'trial';
  if (t.startsWith('判決')) return 'verdict';
  if (t.includes('月がかわった')) return 'month';
  if (t.startsWith('──')) return 'day';
  return 'other';
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
function selectBrains(costSink: CostSink): {
  brain: Brain;
  worldBrain: WorldBrain;
  registry: BackendRegistry | null;
} {
  const mode = process.env.PAGUS_BRAIN ?? 'stub';
  if (mode === 'stub') {
    // stub モードは LLM を呼ばないのでコスト計上なし。
    return {
      brain: new StubBrain({ triggerAfter: numEnv('PAGUS_TRIGGER_AFTER', 6), damagePerStep: 4 }),
      worldBrain: new StubWorldBrain(),
      registry: null,
    };
  }
  if (mode === 'llm') {
    // codex(gpt-5.5) は既定キャストに合流済 (一過性 exit 1 は CLI レベルのリトライで吸収、
    // PAGUS_CLI_RETRIES で調整)。PAGUS_DISABLE_CODEX=1 で外せる。
    const disableCodex = (process.env.PAGUS_DISABLE_CODEX ?? '') === '1';
    const cast = disableCodex ? DEFAULT_CAST : [...DEFAULT_CAST, GPT_BACKEND];
    const strong = disableCodex ? DEFAULT_STRONG : [...DEFAULT_STRONG, GPT_BACKEND];
    const registry = new BackendRegistry({ cast, strong });
    return {
      brain: new LlmBrain(registry, { costSink }),
      worldBrain: new LlmWorldBrain(registry, { costSink }),
      registry,
    };
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
  const startedAt = Date.now(); // 状態パネル (§7) の稼働開始時刻
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
    // ゲーム内月のテーマは実カレンダーに連動 (新規開始時のみ)。村のルール (§8.1) を 4 件入れる。
    const now = new Date();
    world = createWorld(
      loadSeed(),
      config,
      { year: now.getFullYear(), month: now.getMonth() + 1 },
      pickVillageRules(Math.random, 4),
    );
  }
  const villagers = [...world.villagers.values()];

  // LLM コストログ (§7)。llm モードのみ計上 (stub は costSink を呼ばない)。
  // コスト計上時に sysStatus を速やかに反映する (§2.3 イベント駆動)。実体は後で差し込む。
  const costLog = new CostLog();
  let scheduleSysStatus: () => void = () => {};
  const { brain, worldBrain, registry } = selectBrains((e) => {
    costLog.record(e);
    scheduleSysStatus();
  });
  const llmInfo = buildLlmInfo(registry, villagers);
  const director = new EventDirector({ maxRepsPerSegment: numEnv('PAGUS_REPS', 3) });
  const tm = new TermMachine(world, brain, {
    director,
    dailyTriggerAfter: numEnv('PAGUS_TRIGGER_AFTER', 6), // 日常エンジンが自由行動を事件化する閾値 (§12.2)
    worldBrain,
    reconcileChance: numEnv('PAGUS_RECONCILE', 0.15), // 事件が和解で収まる基礎確率
    secondaryChance: numEnv('PAGUS_SECONDARY', 0.18), // 二次被害の確率
    stressFizzleK: numEnv('PAGUS_STRESS_K', 0.06), // ストレス耐性で嫌がらせを受け流す効き
    marriageChance: numEnv('PAGUS_MARRIAGE', 0.12), // 日末の結婚確率
    birthChance: numEnv('PAGUS_BIRTH', 0.1), // 日末の出産確率
    rulesMax: numEnv('PAGUS_RULES_MAX', 40), // ふるまいの法則の上限 (§2.1)
    bornCount: restored?.bornCount ?? 0, // 出生 id の通し番号を引き継ぐ
    incidentCount: restored?.incidentCount ?? 0, // 事件用キャラ id の通し番号を引き継ぐ
    ruleCount: restored?.ruleCount ?? 0, // ふるまいの法則 id の通し番号を引き継ぐ
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

  // プレイヤーのカルマ/善性 (userId ごと, §4.4)。1 秒間隔で accrue する。
  const ps = new PlayerState();
  const knownUsers = new Set<string>();
  // 人間の行動記録のリングバッファ (§8, 上限 200)。
  const PLAYER_ACTIONS_CAP = 200;
  const playerActions: PlayerActionEntry[] = [];

  let loop: TermLoop;
  let ws: GameWsServer;

  /** その userId の現状態を本人の全接続へ push。 */
  const pushState = (userId: string): void => {
    ws.sendPlayerState(userId, ps.snapshot(userId, Date.now()));
  };
  /** 人間の行動を記録し全クライアントへ配る (target はどうぶつ名)。 */
  const recordAction = (userId: string, type: PlayerActionEntry['type'], targetId: string): void => {
    const cal = tm.world.calendar;
    const name = tm.world.villagers.get(targetId)?.name ?? targetId;
    playerActions.push({ date: `${cal.month}月${cal.dayOfMonth}日`, userId, type, target: name });
    if (playerActions.length > PLAYER_ACTIONS_CAP) playerActions.shift();
    ws.broadcastPlayerActions(playerActions);
  };

  // HTTP API (push 購読 / 通知経由の投票) と WS を同一ポートに相乗りさせる。
  const httpServer = createServer(
    createRequestListener({ push, onVote: (pick, userId) => loop.vote(pick, userId) }),
  );
  ws = new GameWsServer(httpServer, {
    onHello: (userId) => {
      knownUsers.add(userId);
      pushState(userId);
      scheduleSysStatus(); // 接続時に最新の状態を反映 (§2.3 イベント駆動)
    },
    onIncite: (targetId, rumorAboutId, userId) => {
      knownUsers.add(userId);
      if (!ps.spend(userId, ps.inciteCostValue)) {
        ws.sendRejected(userId, 'カルマが足りない');
        return;
      }
      loop.inciteTarget(targetId, rumorAboutId);
      recordAction(userId, 'incite', targetId);
      pushState(userId);
    },
    onSanction: (targetId, userId) => {
      knownUsers.add(userId);
      if (tm.world.incident || tm.world.trial) {
        ws.sendRejected(userId, 'いま別の裁判が進行中');
        return;
      }
      if (!ps.spend(userId, ps.sanctionCost(userId))) {
        ws.sendRejected(userId, 'カルマが足りない');
        return;
      }
      if (loop.sanction(targetId)) {
        const cal = tm.world.calendar;
        const name = tm.world.villagers.get(targetId)?.name ?? targetId;
        chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `⚖ 制裁: ${name} がつるし上げられた`, 'sanction');
        ws.updateChronicle(chronicle.recent());
      }
      recordAction(userId, 'sanction', targetId);
      pushState(userId);
    },
    onCheer: (targetId, userId) => {
      knownUsers.add(userId);
      if (!ps.cheer(userId, Date.now())) {
        ws.sendRejected(userId, '応援はインターバル中');
        return;
      }
      loop.cheer(targetId);
      recordAction(userId, 'cheer', targetId);
      pushState(userId);
    },
    onVote: (pick, userId) => loop.vote(pick, userId),
  });
  ws.setLlmInfo(llmInfo);
  ws.updateChronicle(chronicle.recent()); // 既存の歴史を初期配信対象に。

  loop = new TermLoop(tm, pace, incidentStepMs, {
    onSnapshot: (w) => {
      ws.broadcastSnapshot(w);
      sessionLog.snapshot(w);
      store.maybeSave(w, tm.getBornCount(), tm.getIncidentCount(), tm.getRuleCount()); // 揮発状態 (出生/改変/評判/法則) を間引いて永続化
      scheduleSysStatus(); // スナップショット送信時に状態を反映 (§2.3 イベント駆動)
    },
    onLog: (phase, text) => {
      ws.broadcastLog(phase, text);
      sessionLog.line(phase, text);
      if (isMilestone(text)) {
        const cal = tm.world.calendar;
        chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, text, classifyKind(text));
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
  }, {
    // ふるまいの法則の Haiku 増殖 (§2.1)。PAGUS_RULEGEN=0 で無効化 (既定有効)。
    enabled: (process.env.PAGUS_RULEGEN ?? '1') !== '0',
    chance: numEnv('PAGUS_RULEGEN_CHANCE', 0.15),
  });
  loop.start();

  // 状態パネル (§7): 稼働時間・ゲーム内日付・LLM コストを配信する。
  // stub モードでも uptime/年/日付は出す (cost は空集計)。
  const broadcastSysStatus = (): void => {
    const cal = tm.world.calendar;
    ws.broadcastSysStatus({
      startedAt,
      gameYear: cal.year,
      gameDate: `${cal.month}月${cal.dayOfMonth}日`,
      term: tm.world.term,
      cost: costLog.summary(),
    });
  };
  broadcastSysStatus(); // 初回 (接続前の現値を ws にも保持させる)

  // sysStatus はイベント駆動 (§2.3): スナップショット送信時・コスト計上時・接続時に送る。
  // ただし最短間隔 1.5s でデバウンスし、無駄打ちを抑える。タイマーは 30s heartbeat に降格。
  const SYS_DEBOUNCE_MS = 1500;
  let lastSysAt = Date.now();
  let sysPending: ReturnType<typeof setTimeout> | null = null;
  scheduleSysStatus = (): void => {
    const since = Date.now() - lastSysAt;
    if (since >= SYS_DEBOUNCE_MS) {
      lastSysAt = Date.now();
      broadcastSysStatus();
    } else if (!sysPending) {
      sysPending = setTimeout(() => {
        sysPending = null;
        lastSysAt = Date.now();
        broadcastSysStatus();
      }, SYS_DEBOUNCE_MS - since);
    }
  };
  const sysTimer = setInterval(broadcastSysStatus, 30000); // フォールバックの heartbeat

  // カルマを 1 秒ごとに自動加算し、数秒おきに接続中ユーザへ状態を間引き push する (§4.4)。
  let stateTicks = 0;
  const stateTimer = setInterval(() => {
    ps.accrue(Date.now());
    stateTicks += 1;
    if (stateTicks % 3 === 0) for (const uid of knownUsers) pushState(uid);
  }, 1000);

  // Ctrl-C でループを止めログを flush してから抜ける。
  const shutdown = (): void => {
    clearInterval(stateTimer);
    clearInterval(sysTimer);
    if (sysPending) clearTimeout(sysPending);
    loop.stop();
    store.save(tm.world, tm.getBornCount(), tm.getIncidentCount(), tm.getRuleCount()); // 終了時は確実に最新を書き出す
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
