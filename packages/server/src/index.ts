// Pagus server エントリ。data からワールドを起こし、TermLoop と WS を配線する。
// 思考は PAGUS_BRAIN で切替: 'stub'(既定/決定的) | 'llm'(実 LLM = claude/codex CLI)。
//
// チューニング値・秘密 (旧 PAGUS_* env) は暗号化 config (loadPagusConfig) に集約し、
// ここで 1 回読んで各モジュールへコンストラクタ注入する (各モジュールは env を読まない)。
// 例外で env 維持: PAGUS_CONFIG_KEY (マスター鍵) / PAGUS_FRESH (その起動だけ world.json 無視) /
// PAGUS_BRAIN (stub|llm の起動モード) / PAGUS_DATA_DIR (config 自体の置き場を解決するため)。

import { createWorld, TermMachine, StubBrain, StubWorldBrain, EventDirector, pickVillageRules, addVillageRule, removeVillageRule, makeDisasterRule, aliveVillagers, PERSONALITY_LABELS, ITEM_LABELS, rollVillagerGacha, ensureResidentHistory, addVillagerActionLog, KARMA_GACHA_COST, type Brain, type WorldBrain, type LlmInfo, type PlayerActionEntry, type ChronicleKind, type World, type CardName, type DisasterKind, type MarketItem, type VillagerGachaKind, type ChatMessage } from '@pagus/sim';
import { loadConfig, loadSeed } from './load-data.js';
import { loadPagusConfig, type PagusConfig } from './config/pagus-config.js';
import { TermLoop } from './term-loop.js';
import { GameWsServer } from './ws-server.js';
import { PlayerState } from './player-state.js';
import { BetPool } from './bet-pool.js';
import { AuctionManager } from './auction.js';
import { Governance } from './governance.js';
import { SpectacleManager, RaidManager, SeasonStore } from './spectacle.js';
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

/**
 * PAGUS_BRAIN で 個体 Brain と 世界側 WorldBrain を一括で選ぶ (既定 'stub')。
 * 'llm' は claude/codex CLI 駆動。両者で同一 BackendRegistry を共有する。
 * チューニング (triggerAfter / disableCodex / cliRetries) は config から受ける。
 * 不正値は無言フォールバックせず即エラー (RULE_CODE §7.1)。
 */
function selectBrains(costSink: CostSink, cfg: PagusConfig): {
  brain: Brain;
  worldBrain: WorldBrain;
  registry: BackendRegistry | null;
} {
  const mode = process.env.PAGUS_BRAIN ?? 'stub'; // 起動モードは env 維持 (launch behavior)
  if (mode === 'stub') {
    // stub モードは LLM を呼ばないのでコスト計上なし。
    return {
      brain: new StubBrain({ triggerAfter: cfg.sim.triggerAfter, damagePerStep: 4 }),
      worldBrain: new StubWorldBrain(),
      registry: null,
    };
  }
  if (mode === 'llm') {
    // codex(gpt-5.5) は既定キャストに合流済 (一過性 exit 1 は CLI レベルのリトライで吸収、
    // config.llm.cliRetries で調整)。config.llm.disableCodex=true で外せる。
    const disableCodex = cfg.llm.disableCodex;
    const retries = cfg.llm.cliRetries;
    const cast = disableCodex ? DEFAULT_CAST : [...DEFAULT_CAST, GPT_BACKEND];
    const strong = disableCodex ? DEFAULT_STRONG : [...DEFAULT_STRONG, GPT_BACKEND];
    const registry = new BackendRegistry({ cast, strong });
    return {
      brain: new LlmBrain(registry, { costSink, retries }),
      worldBrain: new LlmWorldBrain(registry, { costSink, retries }),
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

function dateLabel(w: World): string {
  return `${w.calendar.month}月${w.calendar.dayOfMonth}日`;
}

async function summarizeDailyHighlight(
  client: Pick<CliLlmClient, 'invoke'> | null,
  date: string,
  logs: string[],
  actions: string[],
): Promise<string> {
  const source = [
    ...logs.slice(-20).map((s) => `出来事: ${s}`),
    ...actions.slice(-40).map((s) => `住民行動: ${s}`),
  ];
  if (source.length === 0) return '目立った事件はなく、村は静かに一日を終えた。';
  if (!client) return source.slice(-3).join(' / ');
  try {
    const res = await client.invoke({
      system: 'あなたは村シミュレーションの編集者です。個別の住民行動を列挙せず、その日の結果と事件のあらましだけを日本語で80字以内に要約してください。',
      prompt: `${date}の記録をハイライトにまとめてください。\n${source.join('\n')}`,
      timeoutMs: 60_000,
    });
    return res.text.replace(/\s+/g, ' ').slice(0, 140);
  } catch (e) {
    console.error('[pagus] daily highlight summary failed', e);
    return source.slice(-3).join(' / ');
  }
}

function main(): void {
  const startedAt = Date.now(); // 状態パネル (§7) の稼働開始時刻
  const cfg = loadPagusConfig(); // 暗号化 config (旧 PAGUS_* env の集約先) を 1 回ロード
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
  }, cfg);
  const llmInfo = buildLlmInfo(registry, villagers);
  const brainFor = (id: string): string | null => (registry ? registry.assign(id).id : null);
  ensureResidentHistory(world, brainFor);
  const director = new EventDirector({ maxRepsPerSegment: cfg.sim.reps });
  const tm = new TermMachine(world, brain, {
    director,
    dailyTriggerAfter: cfg.sim.triggerAfter, // 日常エンジンが自由行動を事件化する閾値 (§12.2)
    worldBrain,
    reconcileChance: cfg.sim.reconcileChance, // 事件が和解で収まる基礎確率
    secondaryChance: cfg.sim.secondaryChance, // 二次被害の確率
    stressFizzleK: cfg.sim.stressFizzleK, // ストレス耐性で嫌がらせを受け流す効き
    marriageChance: cfg.sim.marriageChance, // 日末の結婚確率
    birthChance: cfg.sim.birthChance, // 日末の出産確率
    rulesMax: cfg.sim.rulesMax, // ふるまいの法則の上限 (§2.1)
    martialSurgeBonus: cfg.sim.martialSurgeBonus, // 戒厳令 surge の事件化閾値ボーナス (§v1.3-C ⑨)
    bornCount: restored?.bornCount ?? 0, // 出生 id の通し番号を引き継ぐ
    incidentCount: restored?.incidentCount ?? 0, // 事件用キャラ id の通し番号を引き継ぐ
    ruleCount: restored?.ruleCount ?? 0, // ふるまいの法則 id の通し番号を引き継ぐ
  });

  const port = cfg.server.wsPort;
  const pace = { accel: cfg.server.accel, minMs: cfg.server.minMs };
  const incidentStepMs = cfg.server.incidentStepMs;

  // 住民の動きを stdout へ流しつつ JSONL へ永続化する (後から振り返れる)。
  const sessionLog = new SessionLog({
    logStdout: cfg.server.logStdout,
    logFile: cfg.server.logFile,
    logDir: cfg.server.logDir,
  });

  // 裁判の糾弾セリフ: llm モードでは Haiku 生成 (65%) + レパートリー蓄積。
  const llmMode = (process.env.PAGUS_BRAIN ?? 'stub') === 'llm';
  const highlightClient = llmMode
    ? new CliLlmClient({ provider: 'claude', model: 'claude-haiku-4-5', retries: cfg.llm.cliRetries })
    : null;
  const narrator = new TrialNarrator(
    llmMode
      ? { client: new CliLlmClient({ provider: 'claude', model: 'claude-haiku-4-5', retries: cfg.llm.cliRetries }) }
      : {},
  );

  // 村の歴史 (節目を記録・永続化)。
  const chronicle = new Chronicle();

  // WebPush 通知 (§4.8)。VAPID 未設定なら無効 (config push.enabled=true + 鍵で有効化)。
  const push = new PushService({
    enabled: cfg.push.enabled,
    vapidPublic: cfg.push.vapidPublic,
    vapidPrivate: cfg.push.vapidPrivate,
    vapidSubject: cfg.push.vapidSubject,
  });

  // プレイヤーのカルマ/善性 (userId ごと, §4.4)。1 秒間隔で accrue する。
  const ps = new PlayerState({
    rate: cfg.karma.rate,
    max: cfg.karma.max,
    inciteCost: cfg.karma.inciteCost,
    sanctionCost: cfg.karma.sanctionCost,
    sanctionVirtueK: cfg.karma.sanctionVirtueK,
    cheerIntervalMs: cfg.karma.cheerIntervalMs,
    cheerVirtue: cfg.karma.cheerVirtue,
    championKarmaMult: cfg.karma.championKarmaMult,
    championDeathPenalty: cfg.karma.championDeathPenalty,
    cardCooldownMs: cfg.karma.cardCooldownMs,
  });
  const knownUsers = new Set<string>();

  // 課金モック (§v1.3-F): 許可する固定パック値 (config economy.topupPacks 既定 [100,500,1000])。
  // 不正値 (非正/非整数) は無言フォールバックせず即エラー (RULE_CODE §7.1)。
  const TOPUP_PACKS = new Set<number>(
    cfg.economy.topupPacks.map((n) => {
      if (!Number.isInteger(n) || n <= 0) throw new Error(`config economy.topupPacks の値が正の整数ではありません: ${n}`);
      return n;
    }),
  );

  // 裁判ベット (§3): 現裁判 (incidentId) ごとのプール。
  const betPool = new BetPool();
  const BET_MIN = cfg.economy.betMin;
  // 決済済みの裁判 incidentId (多重清算防止, §3)。
  const settledBets = new Set<string>();
  // fate 段階の betState を最後に初期配信した incidentId (重複初期配信の抑制)。
  let lastBetIncident: string | null = null;

  // カードパック (§v1.3-A) の card 別コストと効果日数。
  const CARD_COSTS: Record<CardName, number> = {
    disaster: cfg.cards.disasterCost,
    spiritAway: cfg.cards.spiritAwayCost,
    swap: cfg.cards.swapCost,
    awaken: cfg.cards.awakenCost,
    falseProphecy: cfg.cards.prophecyCost,
  };
  const DISASTER_DAYS = cfg.cards.disasterDays;
  const SPIRITAWAY_DAYS = cfg.cards.spiritAwayDays;
  // 天災カードルールの通し番号 (id 衝突回避)。
  let cardRuleCount = 0;

  // 経済パック (§v1.3-B) の設定。
  const INSURE_DAYS = cfg.economy.insureDays; // 推し保険の有効日数 (③)
  const INSURE_MULT = cfg.economy.insureMult; // 保険の払戻倍率 (③)
  const REVIVE_COST = cfg.economy.reviveCost; // 闇市の復活コスト (⑤)
  const AUCTION_PERIOD_MS = cfg.economy.auctionPeriodMs; // オークション締切間隔 (②)
  const MARKET_PREMIUM = cfg.economy.marketPremium; // 闇市カードのプレミアム倍率 (⑤)
  // 闇市の card_* → カードパック (A) の種別。
  const MARKET_CARD: Partial<Record<MarketItem, CardName>> = {
    card_disaster: 'disaster',
    card_swap: 'swap',
    card_awaken: 'awaken',
    card_prophecy: 'falseProphecy',
  };
  // 復活候補: 最近退場した villager id (新しいものを末尾に積む, 上限20)。
  const RECENT_DEAD_CAP = 20;
  const recentDeadIds: string[] = [];
  // 利子付与/保険掃除を回した最後のターム (日末検知用)。初回 snapshot で seed。
  let lastEconomyTerm = tm.world.term;

  // しきたり改定 (§2) のコスト/上限。
  const RULE_ADD_COST = cfg.economy.ruleAddCost;
  const RULE_REMOVE_COST = cfg.economy.ruleRemoveCost;
  const VILLAGE_RULES_MAX = cfg.economy.villageRulesMax;
  // 推しの死の検知 (§1): 前回 alive だった villager id 集合。初回 snapshot で現状を seed する。
  const prevAliveIds = new Set<string>();
  let aliveInitialized = false;
  // 人間の行動記録のリングバッファ (§8, 上限 200)。
  const PLAYER_ACTIONS_CAP = 200;
  const playerActions: PlayerActionEntry[] = [];
  // ユーザー間チャットのリングバッファ。
  const CHAT_CAP = 100;
  const chatMessages: ChatMessage[] = [];
  let dailyHighlightDate = dateLabel(tm.world);
  let dailyHighlightPending = false;
  let dailyHighlightDoneTerm = -1;
  const dailyLogs: string[] = [];
  const dailyActions: string[] = [];

  let loop: TermLoop;
  let ws: GameWsServer;
  let auction: AuctionManager;
  let governance: Governance;
  let spectacle: SpectacleManager;
  let raid: RaidManager;

  // 演出・協力パック (§v1.3-D) の設定。
  const RAID_CHANCE = cfg.spectacle.raidChance; // 日末にレイドが出現する確率 (㉙)
  // 月替わり検知 (MVP集計 / シーズン進行 / 予測リセット) と事件発火検知 (予測判定) の基準。
  let lastMonthKey = tm.world.calendar.year * 12 + tm.world.calendar.month;
  let lastScheduledFired = tm.world.scheduledIncident?.fired ?? false;

  // 政治パック (§v1.3-C) の設定。
  const REVOLT_THRESHOLD = cfg.politics.revoltThreshold; // 蜂起の悪辣しきい値 (⑧)
  const MARTIAL_DAYS = cfg.politics.martialDays; // 戒厳令の有効日数 (⑨)
  const RECALL_STAKE = cfg.politics.recallStake; // 村長リコール請願のカルマ費 (§17)
  // 戒厳令の発動と日末の期限切れ検知 (term 進行ベース)。
  let lastGovTerm = tm.world.term;

  /** その userId の現状態を本人の全接続へ push (推し名は world から補完, §1)。 */
  const pushState = (userId: string): void => {
    const snap = ps.snapshot(userId, Date.now());
    const name = snap.championId ? tm.world.villagers.get(snap.championId)?.name : undefined;
    ws.sendPlayerState(userId, snap, name);
  };

  /** その userId へ現在のベットプール状態を送る (§3, yourBet は個別)。裁判が無ければ送らない。 */
  const pushBetState = (userId: string): void => {
    const trial = tm.world.trial;
    if (!trial) return;
    betPool.ensure(trial.incidentId);
    ws.sendBetState(userId, trial.incidentId, betPool.totals(), betPool.yourBet(userId));
  };

  /** 接続中の全ユーザへ betState を配る (プール総額が変わったとき)。 */
  const broadcastBetState = (): void => {
    for (const uid of knownUsers) pushBetState(uid);
  };

  /** リーダーボード (§4.3) を組む。徳目綱引きは world.reputation から。 */
  const buildLeaderboard = (): { players: ReturnType<typeof ps.leaderboard>; factions: { guide: number; incite: number } } => {
    const rep = tm.world.reputation;
    return {
      players: ps.leaderboard(),
      factions: {
        guide: Math.round((rep.benevolence + rep.order) * 100),
        incite: Math.round(rep.malice * 100),
      },
    };
  };

  // リーダーボード配信は数秒デバウンス (§4.3): stats/faction 変化のたびに呼び、まとめて 1 回配る。
  let lbPending: ReturnType<typeof setTimeout> | null = null;
  const scheduleLeaderboard = (): void => {
    if (lbPending) return;
    lbPending = setTimeout(() => {
      lbPending = null;
      const lb = buildLeaderboard();
      ws.broadcastLeaderboard(lb.players, lb.factions);
    }, 2000);
  };

  /**
   * ベット決済を検知して清算する (§3)。trial.verdict が確定 (death/spared) した incidentId を
   * 1 回だけ処理する。death→死刑側勝ち / spared→教育側勝ち。払い戻しを各ユーザの karma へ加算し、
   * 勝者の betsWon を +1。プール総額が動いたら true (chronicle 更新は呼び出し側)。
   */
  const detectBetSettlement = (w: World): boolean => {
    const trial = w.trial;
    if (!trial || trial.verdict === null) return false;
    const incidentId = trial.incidentId;
    if (settledBets.has(incidentId)) return false;
    settledBets.add(incidentId);
    if (betPool.currentIncidentId !== incidentId) return false; // 誰も賭けていない裁判
    const verdictWins = trial.verdict === 'death' ? 'death' : 'educate';
    const settlement = betPool.settle(verdictWins);
    for (const [uid, payout] of settlement.payouts) {
      ps.addKarma(uid, payout);
      pushState(uid);
    }
    for (const uid of settlement.winners) ps.bumpStat(uid, 'betsWon');
    const cal = w.calendar;
    if (settlement.refunded) {
      if (settlement.payouts.size > 0) {
        chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, '🎲 ベット不成立: 片側に賭けが無く全額返金', 'other');
      }
    } else {
      const side = verdictWins === 'death' ? '死刑' : '教育';
      chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `🎲 ベット決済: ${side}側 ${settlement.winners.length}人が的中`, 'other');
    }
    broadcastBetState(); // プールは空になった
    scheduleLeaderboard();
    return settlement.payouts.size > 0;
  };

  /**
   * 推しの死を検知して弔う (§1)。前回 alive → 今回 消滅(alive=false or 不在) の villager を拾い、
   * 推しにしていた全ユーザへ onChampionDeath + playerState push。推しが 1 人でもいた死には
   * 追悼の村ルールを 1 件追加し chronicle に弔いを刻む。snapshot/chronicle を変えたら true。
   */
  const detectChampionDeaths = (w: World): boolean => {
    const currentAlive = new Set<string>();
    for (const v of w.villagers.values()) if (v.alive) currentAlive.add(v.id);
    if (!aliveInitialized) {
      aliveInitialized = true;
      for (const id of currentAlive) prevAliveIds.add(id);
      return false;
    }
    let changed = false;
    const cal = w.calendar;
    for (const id of prevAliveIds) {
      if (currentAlive.has(id)) continue; // まだ生きている
      const name = w.villagers.get(id)?.name ?? id;
      // 復活候補 (§v1.3-B ⑤): 最近退場した id を積む (重複は末尾へ寄せ直す)。
      const dupe = recentDeadIds.indexOf(id);
      if (dupe >= 0) recentDeadIds.splice(dupe, 1);
      recentDeadIds.push(id);
      if (recentDeadIds.length > RECENT_DEAD_CAP) recentDeadIds.shift();
      // 推し保険の清算 (§v1.3-B ③): この villager に掛けた全契約へ premium×MULT を払戻し解除。
      const payouts = ps.settleInsuranceForDeath(id, INSURE_MULT);
      for (const p of payouts) {
        pushState(p.userId);
        chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `🛡 保険金: ${name} の死で ${p.payout} カルマが払い戻された`, 'other');
        changed = true;
      }
      if (payouts.length > 0) scheduleLeaderboard();
      const mourners = ps.usersWithChampion(id);
      if (mourners.length === 0) continue; // 推しのいない死は弔いなし
      for (const uid of mourners) {
        ps.onChampionDeath(uid);
        ps.bumpStat(uid, 'championDeaths'); // 推しの死 (§4.1)
        pushState(uid);
      }
      scheduleLeaderboard();
      // 弔い (legacy): 死を村のしきたりとして残す (上限内なら)。
      const rule = addVillageRule(w, `「${name}」の名をみだりに口にしてはならない`, VILLAGE_RULES_MAX);
      if (rule) {
        chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `🕯 弔い: ${name} を悼む掟が生まれた`, 'rule');
        changed = true;
      }
    }
    // 生存集合を更新 (次回の差分基準)。
    prevAliveIds.clear();
    for (const id of currentAlive) prevAliveIds.add(id);
    return changed;
  };
  const interventionByUser = new Map<string, number>();
  const tryIntervention = (userId: string): boolean => {
    const term = tm.world.term;
    const date = dateLabel(tm.world);
    if (interventionByUser.get(userId) === term) {
      ws.sendRejected(userId, `介入はゲーム内時間で1日1回までです (${date})`);
      return false;
    }
    return true;
  };

  /** 人間の介入を記録し全クライアントへ配る。成功した介入だけが1日1回制限を消費する。 */
  const recordAction = (
    userId: string,
    type: PlayerActionEntry['type'],
    target: string,
    targetIsVillagerId = true,
  ): void => {
    const date = dateLabel(tm.world);
    const name = targetIsVillagerId ? (tm.world.villagers.get(target)?.name ?? target) : target;
    interventionByUser.set(userId, tm.world.term);
    playerActions.push({ date, userId, type, target: name });
    if (playerActions.length > PLAYER_ACTIONS_CAP) playerActions.shift();
    ws.broadcastPlayerActions(playerActions);
  };

  const recordVillagerAction = (villagerId: string, text: string): void => {
    const v = tm.world.villagers.get(villagerId);
    const villagerName = v?.name ?? villagerId;
    const date = dateLabel(tm.world);
    addVillagerActionLog(tm.world, { date, term: tm.world.term, villagerId, villagerName, text });
    dailyActions.push(`${villagerName}: ${text}`);
  };

  const finalizeDailyHighlight = (): void => {
    if (dailyHighlightPending || dailyHighlightDoneTerm === tm.world.term) return;
    const logs = dailyLogs.splice(0);
    const actions = dailyActions.splice(0);
    const date = dailyHighlightDate;
    dailyHighlightPending = true;
    dailyHighlightDoneTerm = tm.world.term;
    void summarizeDailyHighlight(highlightClient, date, logs, actions)
      .then((summary) => {
        spectacle.recordHighlight(date, '日次ハイライト', 'day', summary);
      })
      .finally(() => {
        dailyHighlightPending = false;
        dailyHighlightDate = dateLabel(tm.world);
      });
  };

  // HTTP API (push 購読 / 通知経由の投票) と WS を同一ポートに相乗りさせる。
  const httpServer = createServer(
    createRequestListener({ push, onVote: (pick, userId) => loop.vote(pick, userId) }),
  );
  ws = new GameWsServer(httpServer, {
    onHello: (userId, userName) => {
      knownUsers.add(userId);
      if (userName !== undefined) ps.setUserName(userId, userName);
      pushState(userId);
      pushBetState(userId); // 進行中の裁判があればベット状態も
      scheduleSysStatus(); // 接続時に最新の状態を反映 (§2.3 イベント駆動)
      scheduleLeaderboard(); // 新規ユーザを反映 (§4.3)
    },
    // 課金モック (§v1.3-F): 許可パックのみ受理し、カルマ + 累計課金額を増やす。
    onTopup: (amount, userId) => {
      knownUsers.add(userId);
      if (!TOPUP_PACKS.has(amount)) {
        ws.sendRejected(userId, '不正な課金パック');
        return;
      }
      ps.topup(userId, amount);
      const cal = tm.world.calendar;
      chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `💴 課金: ¥${amount} ぶんのカルマが供給された`, 'other');
      ws.updateChronicle(chronicle.recent());
      pushState(userId);
      scheduleLeaderboard(); // 課金額 (spent) を一覧へ反映
    },
    // 別端末ログイン (§v1.3-F): ws-server が code を userId に束ね直し旧接続を蹴った後の配線。
    onLogin: (userId) => {
      knownUsers.add(userId);
      pushState(userId);
      pushBetState(userId);
      scheduleSysStatus();
      scheduleLeaderboard();
    },
    onSetUserName: (name, userId) => {
      knownUsers.add(userId);
      const normalized = ps.setUserName(userId, name);
      for (const msg of chatMessages) {
        if (msg.userId === userId) msg.userName = normalized;
      }
      pushState(userId);
      scheduleLeaderboard();
      if (chatMessages.length > 0) ws.broadcastChat(chatMessages);
    },
    onChat: (text, userId) => {
      knownUsers.add(userId);
      const trimmed = text.trim().replace(/\s+/g, ' ').slice(0, 160);
      if (trimmed.length === 0) {
        ws.sendRejected(userId, 'チャット本文が空です');
        return;
      }
      chatMessages.push({
        id: `${Date.now().toString(36)}-${chatMessages.length.toString(36)}`,
        userId,
        userName: ps.getUserName(userId),
        text: trimmed,
        at: Date.now(),
      });
      if (chatMessages.length > CHAT_CAP) chatMessages.shift();
      ws.broadcastChat(chatMessages);
    },
    onIncite: (targetId, rumorAboutId, userId) => {
      knownUsers.add(userId);
      const target = tm.world.villagers.get(targetId);
      if (!target || !target.alive) {
        ws.sendRejected(userId, '扇動対象が不正です');
        return;
      }
      if (!tryIntervention(userId)) return;
      if (!ps.spend(userId, ps.inciteCostValue)) {
        ws.sendRejected(userId, 'カルマが足りない');
        return;
      }
      if (!loop.inciteTarget(targetId, rumorAboutId)) {
        ps.addKarma(userId, ps.inciteCostValue);
        ws.sendRejected(userId, '扇動対象が不正です');
        pushState(userId);
        return;
      }
      ps.bumpStat(userId, 'incites'); // 実績 (§4.1)
      recordAction(userId, 'incite', targetId);
      pushState(userId);
      scheduleLeaderboard();
    },
    onSanction: (targetId, userId) => {
      knownUsers.add(userId);
      if (tm.world.incident || tm.world.trial) {
        ws.sendRejected(userId, 'いま別の裁判が進行中');
        return;
      }
      const target = tm.world.villagers.get(targetId);
      if (!target || !target.alive) {
        ws.sendRejected(userId, '制裁対象が不正です');
        return;
      }
      if (!tryIntervention(userId)) return;
      // オークション落札の制裁無料券 (§v1.3-B ②) があれば消費して無料化。
      const sanctionFree = ps.consumeSanctionFree(userId);
      if (!sanctionFree && !ps.spend(userId, ps.sanctionCost(userId))) {
        ws.sendRejected(userId, 'カルマが足りない');
        return;
      }
      if (loop.sanction(targetId)) {
        const cal = tm.world.calendar;
        const name = tm.world.villagers.get(targetId)?.name ?? targetId;
        chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `⚖ 制裁: ${name} がつるし上げられた`, 'sanction');
        ws.updateChronicle(chronicle.recent());
      } else {
        ws.sendRejected(userId, '制裁対象が不正です');
        return;
      }
      ps.bumpStat(userId, 'sanctions'); // 実績 (§4.1)
      recordAction(userId, 'sanction', targetId);
      pushState(userId);
      scheduleLeaderboard();
    },
    onCheer: (targetId, userId) => {
      knownUsers.add(userId);
      const target = tm.world.villagers.get(targetId);
      if (!target || !target.alive) {
        ws.sendRejected(userId, '応援対象が不正です');
        return;
      }
      if (!tryIntervention(userId)) return;
      if (!ps.cheer(userId, Date.now())) {
        ws.sendRejected(userId, '応援はインターバル中');
        return;
      }
      if (!loop.cheer(targetId)) {
        ws.sendRejected(userId, '応援対象が不正です');
        return;
      }
      ps.bumpStat(userId, 'cheers'); // 実績 (§4.1)
      recordAction(userId, 'cheer', targetId);
      pushState(userId);
      scheduleLeaderboard();
    },
    onVote: (pick, userId) => loop.vote(pick, userId),
    onChampion: (targetId, userId) => {
      knownUsers.add(userId);
      const v = tm.world.villagers.get(targetId);
      if (!v || !v.alive) {
        ws.sendRejected(userId, 'その推しは指名できない (生存どうぶつのみ)');
        return;
      }
      if (!tryIntervention(userId)) return;
      ps.setChampion(userId, targetId);
      recordAction(userId, 'champion', targetId);
      pushState(userId);
    },
    onVillagerGacha: (kind: VillagerGachaKind, userId) => {
      knownUsers.add(userId);
      if (kind !== 'free' && kind !== 'karma') {
        ws.sendRejected(userId, 'ガチャ種別が不正です');
        return;
      }
      if (!tryIntervention(userId)) return;
      if (kind === 'karma' && !ps.spend(userId, KARMA_GACHA_COST)) {
        ws.sendRejected(userId, `カルマが足りません (${KARMA_GACHA_COST})`);
        return;
      }
      const rolled = rollVillagerGacha(tm.world, kind, { llmBrain: null });
      rolled.history.llmBrain = brainFor(rolled.villager.id);
      if (aliveInitialized) prevAliveIds.add(rolled.villager.id);
      const cal = tm.world.calendar;
      const paid = kind === 'karma' ? `カルマ${KARMA_GACHA_COST}` : '無料';
      chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `🎲 ${paid}ガチャ: ${rolled.villager.name} (${rolled.history.archetype ?? '新入り'}) が村に来た`, 'other');
      ws.updateChronicle(chronicle.recent());
      ws.broadcastSnapshot(tm.world);
      recordAction(userId, 'villagerGacha', rolled.villager.name, false);
      pushState(userId);
    },
    // フィールドアイテム配置 (§16): カルマ消費なし・ランダム配布。toChampion で推しに直送。
    onPlaceItem: (kind, toChampion, userId) => {
      knownUsers.add(userId);
      const cal = tm.world.calendar;
      const date = `${cal.month}月${cal.dayOfMonth}日`;
      if (!tryIntervention(userId)) return;
      if (toChampion) {
        const championId = ps.snapshot(userId, Date.now()).championId;
        if (!championId) {
          ws.sendRejected(userId, '推しが未指名 (先に推しを指名)');
          return;
        }
        const res = tm.giveChampionItem(kind, championId);
        if (!res) {
          ws.sendRejected(userId, 'その推しは不在 (生存どうぶつのみ)');
          return;
        }
        chronicle.add(date, `🎁 ${ITEM_LABELS[res.kind]}を推しの ${res.name} に渡した`, 'other');
        recordAction(userId, 'placeItem', `${ITEM_LABELS[res.kind]} → ${res.name}`, false);
      } else {
        const item = tm.placeItem(kind);
        chronicle.add(date, `🎁 ${ITEM_LABELS[item.kind]}がフィールドに置かれた`, 'other');
        recordAction(userId, 'placeItem', `${ITEM_LABELS[item.kind]} → フィールド`, false);
      }
      ws.updateChronicle(chronicle.recent());
      ws.broadcastSnapshot(tm.world);
    },
    onAddRule: (text, userId) => {
      knownUsers.add(userId);
      const trimmed = text.trim();
      if (trimmed.length < 1 || trimmed.length > 40) {
        ws.sendRejected(userId, 'しきたりは1〜40文字');
        return;
      }
      if (tm.world.villageRules.length >= VILLAGE_RULES_MAX) {
        ws.sendRejected(userId, 'しきたりが上限に達している');
        return;
      }
      if (!tryIntervention(userId)) return;
      if (!ps.spend(userId, RULE_ADD_COST)) {
        ws.sendRejected(userId, 'カルマが足りない');
        return;
      }
      // 上限は直前に確認済 → maxRules を渡さず必ず追加 (同期処理なので競合なし)。
      addVillageRule(tm.world, trimmed);
      ps.bumpStat(userId, 'rulesAdded'); // 実績 (§4.1)
      const cal = tm.world.calendar;
      chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `📜 しきたり: 「${trimmed}」が定められた`, 'rule');
      ws.updateChronicle(chronicle.recent());
      ws.broadcastSnapshot(tm.world);
      recordAction(userId, 'addRule', trimmed, false);
      pushState(userId);
      scheduleLeaderboard();
    },
    onRemoveRule: (ruleId, userId) => {
      knownUsers.add(userId);
      const rule = tm.world.villageRules.find((r) => r.id === ruleId);
      if (!rule) {
        ws.sendRejected(userId, 'そのしきたりは存在しない');
        return;
      }
      if (!tryIntervention(userId)) return;
      if (!ps.spend(userId, RULE_REMOVE_COST)) {
        ws.sendRejected(userId, 'カルマが足りない');
        return;
      }
      const text = rule.text;
      removeVillageRule(tm.world, ruleId);
      const cal = tm.world.calendar;
      chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `📜 しきたり: 「${text}」が廃された`, 'rule');
      ws.updateChronicle(chronicle.recent());
      ws.broadcastSnapshot(tm.world);
      recordAction(userId, 'removeRule', text, false);
      pushState(userId);
    },
    onBet: (pick, amount, userId) => {
      knownUsers.add(userId);
      const trial = tm.world.trial;
      // 運命 (fate) 段階の裁判が開いているときのみ賭けられる (§3)。
      if (!trial || trial.stage !== 'fate') {
        ws.sendRejected(userId, 'いまはベットできない (裁判の運命段階のみ)');
        return;
      }
      if (!Number.isInteger(amount)) {
        ws.sendRejected(userId, '賭け金は整数で指定');
        return;
      }
      if (amount < BET_MIN) {
        ws.sendRejected(userId, `賭けは ${BET_MIN} カルマ以上`);
        return;
      }
      if (amount > ps.get(userId).karma) {
        ws.sendRejected(userId, 'カルマが足りない');
        return;
      }
      const incidentId = trial.incidentId;
      betPool.ensure(incidentId);
      // 別 pick への乗り換えは不可 (増額のみ) → カルマを引く前に弾く (§3)。
      const existing = betPool.yourBet(userId);
      if (existing && existing.pick !== pick) {
        ws.sendRejected(userId, '別の選択肢には乗り換えできない (増額のみ可)');
        return;
      }
      if (!ps.spend(userId, amount)) {
        ws.sendRejected(userId, 'カルマが足りない');
        return;
      }
      const res = betPool.place(incidentId, userId, pick, amount);
      if (!res.ok) {
        ps.addKarma(userId, amount); // 想定外の拒否は返金 (握り潰さない)
        ws.sendRejected(userId, res.reason);
        return;
      }
      pushState(userId);
      broadcastBetState(); // プール総額が変わったので全員へ
    },
    onFaction: (side, userId) => {
      knownUsers.add(userId);
      if (side !== 'guide' && side !== 'incite') {
        ws.sendRejected(userId, '陣営は guide / incite のいずれか');
        return;
      }
      ps.setFaction(userId, side);
      scheduleLeaderboard();
    },
    onCard: (card, args, userId) => {
      knownUsers.add(userId);
      const w = tm.world;
      const cost = CARD_COSTS[card];
      if (cost === undefined) {
        ws.sendRejected(userId, '不明なカード');
        return;
      }
      if (!tryIntervention(userId)) return;
      const now = Date.now();
      if (!ps.canUseCard(userId, now)) {
        // オークション落札の「カード招待状」(§v1.3-B ②) があればクールダウンを 1 回無視。
        if (!ps.consumeCardFree(userId)) {
          ws.sendRejected(userId, 'カードはクールダウン中');
          return;
        }
      }
      const cal = w.calendar;
      const date = `${cal.month}月${cal.dayOfMonth}日`;
      // 効果テキスト (chronicle 用)。入力検証 → カルマ → spend+markCard → 操作 の順で各 card を処理する。
      let chronicleText: string;
      if (card === 'disaster') {
        const kind = args.kind;
        if (kind !== 'drought' && kind !== 'storm' && kind !== 'plague') {
          ws.sendRejected(userId, '天災の種別が不正 (drought/storm/plague)');
          return;
        }
        if (!ps.spend(userId, cost)) {
          ws.sendRejected(userId, 'カルマが足りない');
          return;
        }
        ps.markCard(userId, now);
        cardRuleCount += 1;
        tm.addCardRule(makeDisasterRule(kind as DisasterKind, w.term + DISASTER_DAYS, `card_disaster_${cardRuleCount}`));
        // 疫病は感情だけでなくストレスも上げる (§v1.3-A ⑯)。
        if (kind === 'plague') for (const v of aliveVillagers(w)) v.stress += 1;
        const label = kind === 'drought' ? '干ばつ' : kind === 'storm' ? '嵐' : '疫病';
        chronicleText = `🃏 天災: ${label}が村を襲う (${DISASTER_DAYS}日)`;
      } else if (card === 'spiritAway') {
        const targetId = args.targetId;
        const target = targetId ? w.villagers.get(targetId) : undefined;
        if (!targetId || !target || !target.alive) {
          ws.sendRejected(userId, '神隠しの対象が不正 (生存どうぶつのみ)');
          return;
        }
        if (!ps.spend(userId, cost)) {
          ws.sendRejected(userId, 'カルマが足りない');
          return;
        }
        ps.markCard(userId, now);
        tm.spiritAway(targetId, SPIRITAWAY_DAYS);
        chronicleText = `🃏 神隠し: ${target.name} が忽然と姿を消した`;
      } else if (card === 'swap') {
        const aId = args.targetId;
        const bId = args.targetId2;
        const a = aId ? w.villagers.get(aId) : undefined;
        const b = bId ? w.villagers.get(bId) : undefined;
        if (!aId || !bId || aId === bId || !a || !a.alive || !b || !b.alive) {
          ws.sendRejected(userId, '入れ替えの対象が不正 (異なる生存どうぶつ2体)');
          return;
        }
        if (!ps.spend(userId, cost)) {
          ws.sendRejected(userId, 'カルマが足りない');
          return;
        }
        ps.markCard(userId, now);
        tm.swapVillagers(aId, bId);
        chronicleText = `🃏 入れ替え: ${a.name} と ${b.name}`;
      } else if (card === 'awaken') {
        const targetId = args.targetId;
        const target = targetId ? w.villagers.get(targetId) : undefined;
        if (!targetId || !target || !target.alive) {
          ws.sendRejected(userId, '覚醒の対象が不正 (生存どうぶつのみ)');
          return;
        }
        if (!ps.spend(userId, cost)) {
          ws.sendRejected(userId, 'カルマが足りない');
          return;
        }
        ps.markCard(userId, now);
        const res = tm.awaken(targetId);
        const axisLabel = res ? (PERSONALITY_LABELS[res.axis] ?? res.axis) : '気質';
        chronicleText = `🃏 覚醒: ${target.name} の${axisLabel}が目覚めた`;
      } else {
        // falseProphecy
        if (!ps.spend(userId, cost)) {
          ws.sendRejected(userId, 'カルマが足りない');
          return;
        }
        ps.markCard(userId, now);
        const n = tm.falseProphecy(args.text);
        chronicleText = `🃏 偽予言: 不吉な噂が ${n}体に広がった`;
      }
      chronicle.add(date, chronicleText, 'other');
      ws.updateChronicle(chronicle.recent());
      ws.broadcastSnapshot(w);
      recordAction(userId, 'card', chronicleText, false);
      pushState(userId);
    },
    // --- 経済パック (§v1.3-B) ---------------------------------------------------
    onInsure: (targetId, premium, userId) => {
      knownUsers.add(userId);
      const target = targetId ? tm.world.villagers.get(targetId) : undefined;
      if (!targetId || !target || !target.alive) {
        ws.sendRejected(userId, '保険の対象が不正 (生存どうぶつのみ)');
        return;
      }
      if (!Number.isInteger(premium) || premium <= 0) {
        ws.sendRejected(userId, '保険料は正の整数');
        return;
      }
      if (!tryIntervention(userId)) return;
      if (!ps.spend(userId, premium)) {
        ws.sendRejected(userId, 'カルマが足りない');
        return;
      }
      ps.insure(userId, targetId, premium, tm.world.term + INSURE_DAYS);
      const cal = tm.world.calendar;
      chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `🛡 保険: ${target.name} に ${premium} カルマ (${INSURE_DAYS}日)`, 'other');
      ws.updateChronicle(chronicle.recent());
      recordAction(userId, 'insure', `${target.name} / ${premium}`, false);
      pushState(userId);
    },
    onBid: (lotId, amount, userId) => {
      knownUsers.add(userId);
      const res = auction.bid(lotId, userId, amount, Date.now());
      if (!res.ok) {
        ws.sendRejected(userId, res.reason);
        return;
      }
      // 入札時はカルマを徴収しない (落札時のみ)。ロット状態は onChange で broadcast 済。
    },
    onBuyMarket: (item, args, userId) => {
      knownUsers.add(userId);
      const w = tm.world;
      const cal = w.calendar;
      const date = `${cal.month}月${cal.dayOfMonth}日`;
      if (!tryIntervention(userId)) return;
      if (item === 'revive') {
        // 復活候補を新しい順に探す (alive=false で消えていない直近の死者)。
        let reviveId: string | null = null;
        for (let i = recentDeadIds.length - 1; i >= 0; i -= 1) {
          const id = recentDeadIds[i];
          const v = id ? w.villagers.get(id) : undefined;
          if (id && v && !v.alive) {
            reviveId = id;
            break;
          }
        }
        if (!reviveId) {
          ws.sendRejected(userId, '復活できる死者がいない');
          return;
        }
        if (!ps.spend(userId, REVIVE_COST)) {
          ws.sendRejected(userId, 'カルマが足りない');
          return;
        }
        const name = w.villagers.get(reviveId)?.name ?? reviveId;
        if (!tm.revive(reviveId)) {
          ps.addKarma(userId, REVIVE_COST); // 想定外の失敗は返金 (握り潰さない)
          ws.sendRejected(userId, '復活に失敗した');
          return;
        }
        const di = recentDeadIds.indexOf(reviveId);
        if (di >= 0) recentDeadIds.splice(di, 1);
        // 復活で次回の死亡検知が誤発火しないよう生存集合に戻す。
        prevAliveIds.add(reviveId);
        chronicle.add(date, `🛒 闇市: ${name} が闇の力で蘇った`, 'other');
        ws.updateChronicle(chronicle.recent());
        ws.broadcastSnapshot(w);
        recordAction(userId, 'buyMarket', `復活: ${name}`, false);
        pushState(userId);
        return;
      }
      const card = MARKET_CARD[item];
      if (!card) {
        ws.sendRejected(userId, '不明な闇市の品');
        return;
      }
      const cost = Math.ceil(CARD_COSTS[card] * MARKET_PREMIUM); // プレミアム価格 (§v1.3-B ⑤)
      let text: string;
      if (card === 'disaster') {
        const kind = args.kind;
        if (kind !== 'drought' && kind !== 'storm' && kind !== 'plague') {
          ws.sendRejected(userId, '天災の種別が不正 (drought/storm/plague)');
          return;
        }
        if (!ps.spend(userId, cost)) {
          ws.sendRejected(userId, 'カルマが足りない');
          return;
        }
        cardRuleCount += 1;
        tm.addCardRule(makeDisasterRule(kind as DisasterKind, w.term + DISASTER_DAYS, `market_disaster_${cardRuleCount}`));
        if (kind === 'plague') for (const v of aliveVillagers(w)) v.stress += 1;
        const label = kind === 'drought' ? '干ばつ' : kind === 'storm' ? '嵐' : '疫病';
        text = `🛒 闇市: 天災(${label})を放った`;
      } else if (card === 'swap') {
        const aId = args.targetId;
        const bId = args.targetId2;
        const a = aId ? w.villagers.get(aId) : undefined;
        const b = bId ? w.villagers.get(bId) : undefined;
        if (!aId || !bId || aId === bId || !a || !a.alive || !b || !b.alive) {
          ws.sendRejected(userId, '入れ替えの対象が不正 (異なる生存どうぶつ2体)');
          return;
        }
        if (!ps.spend(userId, cost)) {
          ws.sendRejected(userId, 'カルマが足りない');
          return;
        }
        tm.swapVillagers(aId, bId);
        text = `🛒 闇市: ${a.name} と ${b.name} を入れ替えた`;
      } else if (card === 'awaken') {
        const targetId = args.targetId;
        const target = targetId ? w.villagers.get(targetId) : undefined;
        if (!targetId || !target || !target.alive) {
          ws.sendRejected(userId, '覚醒の対象が不正 (生存どうぶつのみ)');
          return;
        }
        if (!ps.spend(userId, cost)) {
          ws.sendRejected(userId, 'カルマが足りない');
          return;
        }
        tm.awaken(targetId);
        text = `🛒 闇市: ${target.name} を覚醒させた`;
      } else {
        // falseProphecy
        if (!ps.spend(userId, cost)) {
          ws.sendRejected(userId, 'カルマが足りない');
          return;
        }
        const n = tm.falseProphecy(undefined);
        text = `🛒 闇市: 偽予言を ${n}体に撒いた`;
      }
      chronicle.add(date, text, 'other');
      ws.updateChronicle(chronicle.recent());
      ws.broadcastSnapshot(w);
      recordAction(userId, 'buyMarket', text, false);
      pushState(userId);
    },
    // --- 政治パック (§v1.3-C) + 村長リコール (§17) -----------------------------
    onRecallMayor: (userId) => {
      knownUsers.add(userId);
      if (!tm.world.mayorId) {
        ws.sendRejected(userId, '村長が空位 (リコール対象なし)');
        return;
      }
      if (!tryIntervention(userId)) return;
      if (!ps.spend(userId, RECALL_STAKE)) {
        ws.sendRejected(userId, `カルマが足りない (請願に ${RECALL_STAKE})`);
        return;
      }
      pushState(userId);
      const r = tm.recallMayor();
      const cal = tm.world.calendar;
      const date = `${cal.month}月${cal.dayOfMonth}日`;
      if (r.success) {
        const tail = r.newMayor ? ` → ${r.newMayor} が補欠当選` : '';
        chronicle.add(date, `🏛 リコール成立: ${r.ousted} が罷免された (成功率${Math.round(r.probability * 100)}%)${tail}`, 'other');
      } else {
        chronicle.add(date, `🏛 リコール不成立: 村長の罷免は退けられた (成功率${Math.round(r.probability * 100)}%)`, 'other');
      }
      ws.updateChronicle(chronicle.recent());
      ws.broadcastSnapshot(tm.world);
      recordAction(userId, 'recallMayor', r.success && r.ousted ? `成功: ${r.ousted}` : '不成立', false);
    },
    onProposeLaw: (text, userId) => {
      knownUsers.add(userId);
      if (!tryIntervention(userId)) return;
      const res = governance.proposeLaw(userId, text, Date.now());
      if (!res.ok) ws.sendRejected(userId, res.reason);
      else recordAction(userId, 'proposeLaw', text.trim(), false);
    },
    onVoteLaw: (lawId, approve, userId) => {
      knownUsers.add(userId);
      if (!tryIntervention(userId)) return;
      const res = governance.voteLaw(userId, lawId, approve, Date.now());
      if (!res.ok) ws.sendRejected(userId, res.reason);
      else recordAction(userId, 'voteLaw', `${approve ? '賛成' : '反対'}: ${lawId}`, false);
    },
    onRevolt: (side, userId) => {
      knownUsers.add(userId);
      if (!tryIntervention(userId)) return;
      const res = governance.revolt(userId, side, Date.now());
      if (!res.ok) ws.sendRejected(userId, res.reason);
      else recordAction(userId, 'revolt', side === 'incite' ? '蜂起側' : '鎮圧側', false);
    },
    onMartial: (mode, userId) => {
      knownUsers.add(userId);
      if (!tryIntervention(userId)) return;
      const res = governance.martial(userId, mode, Date.now());
      if (!res.ok) ws.sendRejected(userId, res.reason);
      else recordAction(userId, 'martial', mode, false);
    },
    // --- 演出・協力パック (§v1.3-D) ---------------------------------------------
    onPredictDay: (dayOfMonth, userId) => {
      knownUsers.add(userId);
      // 受付窓: 月初スケジュール後〜発生前 (scheduledIncident があり未発火, ㉓)。
      const sched = tm.world.scheduledIncident;
      if (!sched || sched.fired) {
        ws.sendRejected(userId, 'いまは予測を受け付けていない');
        return;
      }
      const res = spectacle.predict(userId, dayOfMonth, tm.world.calendar.daysInMonth);
      if (!res.ok) ws.sendRejected(userId, res.reason);
    },
    onVoteMvp: (villagerId, userId) => {
      knownUsers.add(userId);
      const v = villagerId ? tm.world.villagers.get(villagerId) : undefined;
      const res = spectacle.voteMvp(userId, villagerId, !!v && v.alive);
      if (!res.ok) ws.sendRejected(userId, res.reason);
    },
    onPray: (userId) => {
      knownUsers.add(userId);
      if (!tryIntervention(userId)) return;
      const res = spectacle.pray(userId, Date.now()); // 無料 (協力要素, ㉕)
      recordAction(userId, 'pray', res.fired ? `祈り発火 (${res.count}人)` : `祈り (${res.count}人)`, false);
      if (!res.fired) return;
      // 閾値到達 → 村バフ発火 (善良/活気 +0.05・全生存 stress-1)。
      tm.applyPrayerBuff();
      const cal = tm.world.calendar;
      chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `🙏 祈り: ${res.count}人の祈りが届き村が癒やされた`, 'other');
      ws.updateChronicle(chronicle.recent());
      ws.broadcastSnapshot(tm.world);
      scheduleLeaderboard(); // 徳目綱引きは reputation 由来
    },
    onRaidStrike: (amount, userId) => {
      knownUsers.add(userId);
      if (!tryIntervention(userId)) return;
      const res = raid.strike(userId, amount, Date.now());
      if (!res.ok) ws.sendRejected(userId, res.reason);
      else recordAction(userId, 'raidStrike', `${amount}カルマ${res.defeated ? ' / 討伐' : ''}`, false);
    },
  });
  ws.setLlmInfo(llmInfo);
  ws.updateChronicle(chronicle.recent()); // 既存の歴史を初期配信対象に。

  // オークション (§v1.3-B ②): 固定ロット3種ローテ。落札時のみカルマ徴収し効果付与する。
  auction = new AuctionManager(
    AUCTION_PERIOD_MS,
    Date.now(),
    (effect, _lotId, winnerUserId, amount) => {
      const cal = tm.world.calendar;
      const date = `${cal.month}月${cal.dayOfMonth}日`;
      const label = effect === 'sanction_free' ? '制裁無料券' : effect === 'virtue_boost' ? '善性のお守り' : 'カード招待状';
      // 落札時にのみ徴収 (入札時 hold しない方式)。残高不足なら流す (無言フォールバック禁止 = 記録する)。
      if (!ps.spend(winnerUserId, amount)) {
        chronicle.add(date, `🔨 オークション: 落札者のカルマ不足で「${label}」は流れた`, 'other');
        ws.updateChronicle(chronicle.recent());
        return;
      }
      if (effect === 'sanction_free') ps.grantSanctionFree(winnerUserId);
      else if (effect === 'virtue_boost') ps.addVirtue(winnerUserId, 0.1);
      else ps.grantCardFree(winnerUserId);
      chronicle.add(date, `🔨 オークション: 「${label}」を ${amount} カルマで落札`, 'other');
      ws.updateChronicle(chronicle.recent());
      pushState(winnerUserId);
      scheduleLeaderboard();
    },
    () => ws.broadcastAuction(auction.view(Date.now())),
  );
  ws.broadcastAuction(auction.view(Date.now())); // 初回 (接続前の現値を ws に保持させる)

  // 政治パック (§v1.3-C): 村長/法案/革命/戒厳令/税。状態と時間管理は Governance、副作用はここ。
  governance = new Governance(
    {
      lawDeposit: cfg.politics.lawDeposit,
      lawVoteMs: cfg.politics.lawVoteMs,
      revoltThreshold: REVOLT_THRESHOLD,
      revoltStake: cfg.politics.revoltStake,
      revoltWindowMs: cfg.politics.revoltWindowMs,
      martialStake: cfg.politics.martialStake,
      martialCost: cfg.politics.martialCost,
      martialDays: MARTIAL_DAYS,
      taxPeriodMs: cfg.politics.taxPeriodMs,
      taxAmount: cfg.politics.taxAmount,
      fundThreshold: cfg.politics.fundThreshold,
    },
    {
      spend: (uid, amt) => ps.spend(uid, amt),
      refund: (uid, amt) => ps.addKarma(uid, amt),
      take: (uid, amt) => {
        const bal = ps.get(uid).karma;
        const taken = Math.min(bal, amt);
        if (taken > 0) ps.spend(uid, taken);
        return taken;
      },
      pushState: (uid) => pushState(uid),
      knownUserIds: () => [...knownUsers],
      enactLaw: (text) => {
        const rule = addVillageRule(tm.world, text, VILLAGE_RULES_MAX);
        if (rule) ws.broadcastSnapshot(tm.world);
        return rule !== null;
      },
      applyRevolt: (side) => {
        tm.applyRevolt(side);
        ws.broadcastSnapshot(tm.world);
        scheduleLeaderboard(); // 徳目綱引きは reputation 由来
      },
      activateMartial: (mode, days) => {
        tm.setMartial(mode, days);
        ws.broadcastSnapshot(tm.world);
      },
      fundEvent: (kind) => {
        tm.villageFundEvent(kind);
        ws.broadcastSnapshot(tm.world);
        scheduleLeaderboard();
      },
      chronicle: (text) => {
        const cal = tm.world.calendar;
        chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, text, 'other');
        ws.updateChronicle(chronicle.recent());
      },
      broadcastLaws: (items) => ws.broadcastLaws(items),
      broadcastRevolt: (active, incite, suppress, endsInMs) => ws.broadcastRevolt(active, incite, suppress, endsInMs),
      broadcastMartial: (mode, endsInMs) => ws.broadcastMartial(mode, endsInMs),
      broadcastFund: (amount, threshold) => ws.broadcastFund(amount, threshold),
    },
    Date.now(),
  );
  governance.broadcastAll(Date.now()); // 初回 (接続前の現値を ws に保持させる)

  // 演出・協力パック (§v1.3-D): ハイライト/予測/MVP/祈り/シーズン。状態と集計は SpectacleManager。
  const seasonStore = new SeasonStore();
  spectacle = new SpectacleManager(
    {
      predictReward: cfg.spectacle.predictReward,
      prayWindowMs: cfg.spectacle.prayWindowMs,
      prayNeeded: cfg.spectacle.prayNeeded,
      seasonMonths: cfg.spectacle.seasonMonths,
      seasonReward: cfg.spectacle.seasonReward,
    },
    {
      addKarma: (uid, amt) => ps.addKarma(uid, amt),
      pushState: (uid) => pushState(uid),
      knownUserIds: () => [...knownUsers],
      factionOf: (uid) => ps.factionOf(uid),
      reputation: () => {
        const rep = tm.world.reputation;
        return { benevolence: rep.benevolence, malice: rep.malice, order: rep.order };
      },
      buildLeaderboard: () => ps.leaderboard(),
      broadcastHighlights: (cards) => ws.broadcastHighlights(cards),
      broadcastSeason: (number, winner, leaderboard) => ws.broadcastSeason(number, winner, leaderboard),
      persistSeason: (record) => seasonStore.append(record),
    },
  );

  // 共闘レイド (§v1.3-D ㉙): 凶悪 villain との協力ミニゲーム。状態と時間管理は RaidManager。
  const RAID_VILLAIN_NAMES = ['黒爪のガロ', '影喰いゾル', '血塗れのバド', '夜歩きのケダ'];
  let raidNameIdx = 0;
  raid = new RaidManager(
    {
      hp: cfg.spectacle.raidHp,
      windowMs: cfg.spectacle.raidWindowMs,
      reward: cfg.spectacle.raidReward,
      chance: RAID_CHANCE,
    },
    {
      spawnVillain: () => {
        const name = RAID_VILLAIN_NAMES[raidNameIdx % RAID_VILLAIN_NAMES.length] ?? '凶賊';
        raidNameIdx += 1;
        const v = tm.spawnVillain(name);
        // spawn を死亡検知の差分基準へ反映 (退場時に誤って弔い扱いされないよう生存集合へ加える)。
        if (aliveInitialized) prevAliveIds.add(v.id);
        return { id: v.id, name: v.name };
      },
      despawnVillain: (id) => {
        tm.despawnVillain(id);
        // レイド villain の退場は弔い対象外 → 死亡検知の差分基準から外す。
        prevAliveIds.delete(id);
      },
      spend: (uid, amt) => ps.spend(uid, amt),
      reward: (uid, amt) => ps.addKarma(uid, amt),
      pushState: (uid) => pushState(uid),
      applyFailure: () => {
        tm.applyRaidFailure();
        scheduleLeaderboard(); // 徳目綱引きは reputation 由来
      },
      chronicle: (text) => {
        const cal = tm.world.calendar;
        chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, text, 'other');
        ws.updateChronicle(chronicle.recent());
      },
      highlight: (title, summary) => {
        const cal = tm.world.calendar;
        spectacle.recordHighlight(`${cal.month}月${cal.dayOfMonth}日`, title, 'other', summary);
      },
      broadcast: (active, villainName, hp, hpMax, endsInMs) => ws.broadcastRaid(active, villainName, hp, hpMax, endsInMs),
      snapshot: () => ws.broadcastSnapshot(tm.world),
    },
  );
  ws.broadcastHighlights(spectacle.highlights()); // 初回 (接続前の現値を ws に保持させる)
  ws.broadcastRaid(false, '', 0, 0, 0);

  /** 月替わりの演出処理 (§v1.3-D): MVP集計 (㉔) / 予測リセット (㉓) / シーズン進行 (㉚)。 */
  const handleMonthRoll = (): void => {
    const cal = tm.world.calendar;
    const date = `${cal.month}月${cal.dayOfMonth}日`;
    // ㉔ 月間MVP を集計し「今月の主役」を発表する。
    const mvp = spectacle.resolveMvp();
    if (mvp) {
      const name = tm.world.villagers.get(mvp.villagerId)?.name ?? mvp.villagerId;
      chronicle.add(date, `🏅 MVP: ${name} が今月の主役に選ばれた (${mvp.votes}票)`, 'other');
      ws.updateChronicle(chronicle.recent());
      ws.broadcastMvp(mvp.villagerId, name);
      spectacle.recordHighlight(date, '月間MVP', 'other', `${name} が今月の主役に輝いた`);
    }
    // ㉓ 新しい月の予測受付を開く (発火検知の基準もリセット)。
    spectacle.resetMonth();
    lastScheduledFired = false;
    // ㉚ シーズン境界なら陣営勝敗を確定する。
    const season = spectacle.advanceSeasonMonth();
    if (season) {
      const label = season.winner === 'guide' ? '善導陣営の勝利' : season.winner === 'incite' ? '扇動陣営の勝利' : '引き分け';
      chronicle.add(date, `🏁 シーズン${season.number} 終幕: ${label}`, 'other');
      ws.updateChronicle(chronicle.recent());
      spectacle.recordHighlight(date, `シーズン${season.number}`, 'other', label);
      scheduleLeaderboard();
    }
  };

  loop = new TermLoop(tm, pace, incidentStepMs, {
    onSnapshot: (w) => {
      // 日末 (term 進行) を検知して保険の期限切れ掃除 (§v1.3-B ③)。
      if (w.term > lastEconomyTerm) {
        finalizeDailyHighlight();
        lastEconomyTerm = w.term;
        ps.pruneExpiredInsurance(w.term);
        for (const uid of knownUsers) pushState(uid);
      }
      // 政治パック (§v1.3-C) の日末処理: 戒厳令の期限切れ解除 + 革命の蜂起判定。
      if (w.term > lastGovTerm) {
        lastGovTerm = w.term;
        const expired = tm.pruneExpiredMartial();
        if (expired) {
          const cal = w.calendar;
          chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, '🛡 戒厳令が解かれた', 'other');
          ws.updateChronicle(chronicle.recent());
          ws.broadcastMartial(null, 0);
        }
        // 悪辣が閾値を超えていたら蜂起ウィンドウを開く (⑧)。
        governance.maybeStartRevolt(w.reputation.malice, Date.now());
        // 共闘レイド (§v1.3-D ㉙): 日末に低確率で凶悪 villain を出現させる (多重防止は内部)。
        raid.maybeSpawn(Date.now());
      }
      // 予測アワード (§v1.3-D ㉓): スケジュール事件が発火した瞬間に的中を判定する。
      const sched = w.scheduledIncident;
      const firedNow = sched?.fired === true;
      if (firedNow && !lastScheduledFired && sched) {
        const payouts = spectacle.resolvePredictions(sched.dayOfMonth);
        if (payouts.length > 0) {
          const cal = w.calendar;
          chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, `🔮 予測的中: ${payouts.length}人が事件発生日 (${sched.dayOfMonth}日) を当てた`, 'other');
          ws.updateChronicle(chronicle.recent());
          scheduleLeaderboard();
        }
      }
      lastScheduledFired = firedNow;
      // 月替わり (§v1.3-D ㉔㉚㉓): MVP集計 / シーズン進行 / 予測リセット。
      const monthKey = w.calendar.year * 12 + w.calendar.month;
      if (monthKey > lastMonthKey) {
        lastMonthKey = monthKey;
        handleMonthRoll();
      }
      const mourned = detectChampionDeaths(w); // 推しの死 → 弔い (world/chronicle を変えうる)
      const settled = detectBetSettlement(w); // ベット決済 (§3, chronicle を変えうる)
      // 運命段階の裁判に入ったら、その incidentId の betState を初回配信 (プールは空)。
      const trial = w.trial;
      if (trial && trial.stage === 'fate' && trial.incidentId !== lastBetIncident) {
        lastBetIncident = trial.incidentId;
        broadcastBetState();
      }
      ws.broadcastSnapshot(w);
      if (mourned || settled) ws.updateChronicle(chronicle.recent());
      sessionLog.snapshot(w);
      store.maybeSave(w, tm.getBornCount(), tm.getIncidentCount(), tm.getRuleCount()); // 揮発状態 (出生/改変/評判/法則) を間引いて永続化
      scheduleSysStatus(); // スナップショット送信時に状態を反映 (§2.3 イベント駆動)
    },
    onVillagerAction: (entry) => {
      recordVillagerAction(entry.villager, entry.action);
    },
    onLog: (phase, text) => {
      ws.broadcastLog(phase, text);
      sessionLog.line(phase, text);
      if (text.includes('はじまり')) {
        dailyHighlightDate = dateLabel(tm.world);
        dailyLogs.length = 0;
        dailyActions.length = 0;
      } else if (phase !== 'kisho' || isMilestone(text)) {
        dailyLogs.push(text);
      }
      if (isMilestone(text)) {
        const cal = tm.world.calendar;
        const kind = classifyKind(text);
        chronicle.add(`${cal.month}月${cal.dayOfMonth}日`, text, kind);
        ws.updateChronicle(chronicle.recent());
        // ハイライト (§v1.3-D ㉑): 処刑 (判決) / 和解 を節目カードとして積む。
        if (kind === 'verdict' || kind === 'reconcile') {
          const title = kind === 'verdict' ? '判決' : '和解';
          spectacle.recordHighlight(`${cal.month}月${cal.dayOfMonth}日`, title, kind, text);
        }
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
    // ふるまいの法則の Haiku 増殖 (§2.1)。config sim.rulegenEnabled で切替 (既定有効)。
    enabled: cfg.sim.rulegenEnabled,
    chance: cfg.sim.rulegenChance,
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
  // リーダーボード初回 (§4.3): 空でも factions (徳目綱引き) は出せる。ws に現値を保持させる。
  {
    const lb0 = buildLeaderboard();
    ws.broadcastLeaderboard(lb0.players, lb0.factions);
  }

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
    // 推し生存中はカルマ加速 (§1)。
    ps.accrue(Date.now(), (uid) => {
      const cid = ps.getChampion(uid);
      return cid !== null && tm.world.villagers.get(cid)?.alive === true;
    });
    stateTicks += 1;
    if (stateTicks % 3 === 0) for (const uid of knownUsers) pushState(uid);
  }, 1000);

  // オークション (§v1.3-B ②): 1 秒ごとに締切判定。期限到来で落札 → 次ロットへローテ + broadcast。
  const auctionTimer = setInterval(() => auction.tick(Date.now()), 1000);

  // 政治パック (§v1.3-C): 1 秒ごとに任期更新 / 法案締切 / 蜂起決着 / 課税を回す。
  const govTimer = setInterval(() => governance.tick(Date.now()), 1000);

  // 共闘レイド (§v1.3-D ㉙): 1 秒ごとに制限時間を判定 (時間切れで失敗 = 村に大被害)。
  const raidTimer = setInterval(() => raid.tick(Date.now()), 1000);

  // Ctrl-C でループを止めログを flush してから抜ける。
  const shutdown = (): void => {
    clearInterval(stateTimer);
    clearInterval(sysTimer);
    clearInterval(auctionTimer);
    clearInterval(govTimer);
    clearInterval(raidTimer);
    if (sysPending) clearTimeout(sysPending);
    if (lbPending) clearTimeout(lbPending);
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
