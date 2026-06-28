// Pagus client エントリ。WS に繋ぎ、ステージ (村/裁判) と左右パネル・ログを更新する。

import { StageView } from './stage-view.js';
import { Radar } from './radar.js';
import { Hud } from './hud.js';
import { TrialPanel } from './trial-panel.js';
import { IncidentPanel } from './incident-panel.js';
import { VillageStatus } from './village-status.js';
import { LogOverlay } from './log-overlay.js';
import { LlmPanel } from './llm-panel.js';
import { ChronicleView } from './chronicle-view.js';
import { StatusPanel } from './status-panel.js';
import { PlayerControls, type ActionType } from './player-controls.js';
import { CardPanel } from './card-panel.js';
import { EconomyPanel } from './economy-panel.js';
import { GovernancePanel } from './governance-panel.js';
import { SpectaclePanel } from './spectacle-panel.js';
import { BetPanel } from './bet-panel.js';
import { LeaderboardPanel } from './leaderboard-panel.js';
import { AccountPanel } from './account-panel.js';
import { ActionOverlay } from './action-overlay.js';
import { connect, type Conn } from './ws-client.js';
import { getUserId, setUserId, enablePush } from './push-client.js';

// 既定は同一オリジンの /ws (Vite が game server 4310 へ proxy)。
// → ローカルでもトンネル (pagus.vtn-game.com) 越しでも繋がる。VITE_WS_URL で上書き可。
function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? defaultWsUrl();

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} が見つかりません`);
  return node;
}

async function main(): Promise<void> {
  const stage = new StageView();
  await stage.mount(el('stage'));

  const radar = new Radar(el('radar') as HTMLCanvasElement);
  const hud = new Hud(el('hud'), el('status'));
  const log = new LogOverlay(el('log'));
  const incident = new IncidentPanel(el('left'));
  const vstatus = new VillageStatus(el('vstatus'));
  const llmPanel = new LlmPanel(el('llm-head'), el('llm-body'));
  const chronicle = new ChronicleView(el('chronicle'), el('chronicle-body'), el('hist-btn'), el('chronicle-close'), {
    // しきたり改定 (§2): カルマを払って村のルールを増減。
    onAddRule: (text) => conn.send({ t: 'addRule', text, userId }),
    onRemoveRule: (ruleId) => conn.send({ t: 'removeRule', ruleId, userId }),
  });
  const statusPanel = new StatusPanel(el('status-head'), el('status-body'));

  const userId = getUserId();
  let conn: Conn;
  const trial = new TrialPanel(el('trial'), (pick) => conn.send({ t: 'vote', pick, userId }));
  // 裁判ベット (§3): 運命段階で死刑/教育に賭ける。
  const betPanel = new BetPanel(el('bet'), (pick, amount) => conn.send({ t: 'bet', pick, amount, userId }));
  // スコアボード (§4): 称号・陣営・綱引き。陣営選択を送る。
  const leaderboard = new LeaderboardPanel(el('leaderboard'), userId, (side) => conn.send({ t: 'faction', side, userId }));

  // アカウント (§v1.3-F): 課金モック / ユーザーコード表示 / 別端末ログイン。
  const account = new AccountPanel(el('account'), userId, {
    onTopup: (amount) => conn.send({ t: 'topup', amount, userId }),
    onLogin: (code) => {
      // ユーザーコードで束ね直す → ローカルの userId を差し替えて全パネルを貼り直す (reload)。
      conn.send({ t: 'login', code });
      setUserId(code);
      setTimeout(() => location.reload(), 400); // login 送信を flush してから貼り直す
    },
  });

  // 操作パネル (§4): 対象を選んで 扇動 / 制裁 / 応援 を送る。
  // 扇動は noun (悪口の主 rumorAboutId) を任意で伴う (§4.2)。未選択なら省略。
  const sendAction = (type: ActionType, targetId: string, rumorAboutId?: string): void => {
    if (type === 'incite') {
      conn.send(rumorAboutId ? { t: 'incite', targetId, rumorAboutId, userId } : { t: 'incite', targetId, userId });
    } else if (type === 'sanction') conn.send({ t: 'sanction', targetId, userId });
    else conn.send({ t: 'cheer', targetId, userId });
  };
  const controls = new PlayerControls(el('controls'), {
    onAction: sendAction,
    // 推し指名 (§1): 選択中の対象を推しにする。
    onChampion: (targetId) => conn.send({ t: 'champion', targetId, userId }),
  });

  // カードパネル (§v1.3-A): カルマで切る一発介入カード 5 種。
  const cards = new CardPanel(el('cards'), {
    onCard: (card, args) => conn.send({ t: 'card', card, userId, ...args }),
  });

  // 経済パネル (§v1.3-B): 送金 / 銀行 / 保険 / 闇市 / オークション。
  const economy = new EconomyPanel(el('economy'), {
    onTransfer: (toUserId, amount) => conn.send({ t: 'transfer', toUserId, amount, userId }),
    onDeposit: (amount) => conn.send({ t: 'deposit', amount, userId }),
    onWithdraw: (amount) => conn.send({ t: 'withdraw', amount, userId }),
    onInsure: (targetId, premium) => conn.send({ t: 'insure', targetId, premium, userId }),
    onBuyMarket: (item, args) => conn.send({ t: 'buyMarket', item, userId, ...args }),
    onBid: (lotId, amount) => conn.send({ t: 'bid', lotId, amount, userId }),
  });

  // 政治パネル (§v1.3-C): 村長 / 法案 / 革命 / 戒厳令 / 村基金。
  const governance = new GovernancePanel(el('governance'), userId, {
    onVoteMayor: (target) => conn.send({ t: 'voteMayor', target, userId }),
    onProposeLaw: (text) => conn.send({ t: 'proposeLaw', text, userId }),
    onVoteLaw: (lawId, approve) => conn.send({ t: 'voteLaw', lawId, approve, userId }),
    onRevolt: (side) => conn.send({ t: 'revolt', side, userId }),
    onMartial: (mode) => conn.send({ t: 'martial', mode, userId }),
  });

  // 演出・協力パネル (§v1.3-D): ハイライト / 予測 / MVP / 祈り / レイド / シーズン。
  const spectacle = new SpectaclePanel(el('spectacle'), {
    onPredictDay: (dayOfMonth) => conn.send({ t: 'predictDay', dayOfMonth, userId }),
    onVoteMvp: (villagerId) => conn.send({ t: 'voteMvp', villagerId, userId }),
    onPray: () => conn.send({ t: 'pray', userId }),
    onRaidStrike: (amount) => conn.send({ t: 'raidStrike', amount, userId }),
  });

  // 統合アクションオーバーレイ (§v1.3-E): 上記の操作パネル群を 1 つのタブ式パネルへ集約。
  // 各パネルは index.html のオーバーレイ内 id に既に mount 済み。ここでは枠 (タブ/ヘッダ/開閉) を起こす。
  const overlay = new ActionOverlay(el('action-overlay'), el('ao-header'), el('ao-tabs'), el('btn-actions'), el('ao-backdrop'));

  const verdict = el('verdict');
  // 死刑/教育ボタンは「殺す/活かす」を決める fate 段階でのみ出す (foolish=被告選びは裁判タブ)。
  const showVerdict = (world: { phase: string; trial: { stage: string } | null }): boolean =>
    world.phase === 'ten' && world.trial?.stage === 'fate';

  conn = connect(WS_URL, {
    onSnapshot: (world) => {
      stage.update(world);
      radar.update(world.reputation);
      hud.updateCalendar(world);
      trial.update(world);
      incident.update(world);
      vstatus.update(world);
      llmPanel.setNames(world);
      chronicle.setWorld(world);
      controls.setWorld(world);
      cards.setWorld(world);
      economy.setWorld(world);
      spectacle.setWorld(world);
      betPanel.update(world);
      verdict.classList.toggle('show', showVerdict(world));
    },
    onLog: (phase, text) => log.add(phase, text),
    onStatus: (status) => {
      hud.setStatus(status);
      // 接続確立時にユーザを名乗る (per-user カルマ push 用)。
      if (status.startsWith('●') && status.includes('接続')) conn.send({ t: 'hello', userId });
    },
    onPlayers: (count) => vstatus.setPlayers(count),
    onTrialLines: (incidentId, lines) => stage.setTrialLines(incidentId, lines),
    onLlm: (info) => llmPanel.setInfo(info),
    onChronicle: (entries) => chronicle.setEntries(entries),
    onSysStatus: (s) => statusPanel.setStatus(s),
    onPlayerState: (state) => {
      controls.setState(state);
      cards.setKarma(state.karma);
      economy.setState(state.karma, state.savings);
      account.setSpent(state.spent);
      // 常時ヘッダ (カルマ/善性/課金/推し/応援クールダウン) を更新。
      overlay.setPlayerState({
        karma: state.karma,
        virtue: state.virtue,
        spent: state.spent,
        championId: state.championId,
        ...(state.championName !== undefined ? { championName: state.championName } : {}),
        canCheerInMs: state.canCheerInMs,
      });
    },
    onCommandRejected: (reason) => showToast(`⚠ ${reason}`),
    onLoggedOut: (reason) => {
      conn.close(); // 再接続を止める (握り潰さない)
      showLoggedOut(reason);
    },
    onPlayerActions: (entries) => chronicle.setActions(entries),
    onBetState: (s) => betPanel.setBetState(s),
    onLeaderboard: (s) => leaderboard.setLeaderboard(s),
    onAuction: (lots) => economy.setAuction(lots),
    onMayor: (mayorId, endsInMs) => governance.setMayor(mayorId, endsInMs),
    onLaws: (items) => governance.setLaws(items),
    onRevolt: (active, incite, suppress, endsInMs) => governance.setRevolt(active, incite, suppress, endsInMs),
    onMartial: (mode) => governance.setMartial(mode),
    onFund: (amount, threshold) => governance.setFund(amount, threshold),
    onHighlights: (cards) => spectacle.setHighlights(cards),
    onMvp: (villagerId, name) => spectacle.setMvp(villagerId, name),
    onRaid: (active, villainName, hp, hpMax, endsInMs) => spectacle.setRaid(active, villainName, hp, hpMax, endsInMs),
    onSeason: (num, winner, leaderboard) => spectacle.setSeason(num, winner, leaderboard),
  });

  // 裁判の票は中央の 死刑/教育 に一本化 (沈静化は廃止 §4.1)。
  //   死刑 = 殺す(kill) 投票、教育 = 活かす(spare→教育) 投票。
  //   同時にプレイヤーの罵倒/擁護を吹き出しで表示。投票し直しは server 側で前票を差し替え。
  el('v-guilty').addEventListener('click', () => {
    conn.send({ t: 'vote', pick: 'kill', userId });
    stage.playerVerdict('guilty');
  });
  el('v-innocent').addEventListener('click', () => {
    conn.send({ t: 'vote', pick: 'spare', userId });
    stage.playerVerdict('innocent');
  });

  // 🔔 通知: 裁判が始まったら端末へ push (接続を閉じていても投票を促す)。
  const pushBtn = el('push-btn');
  pushBtn.addEventListener('click', () => {
    pushBtn.textContent = '🔔 …';
    enablePush()
      .then((label) => {
        pushBtn.textContent = label;
        (pushBtn as HTMLButtonElement).disabled = true;
      })
      .catch((e: unknown) => {
        pushBtn.textContent = `🔔 ${e instanceof Error ? e.message : '失敗'}`;
        setTimeout(() => (pushBtn.textContent = '🔔 通知'), 3000);
      });
  });

  setupDrawers();
}

/** コマンド却下などを画面下部に数秒だけ出すトースト。 */
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(text: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = text;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

/** 別端末ログインで追い出された時の通知 (§v1.3-F)。再接続しないので恒久表示。 */
function showLoggedOut(reason: string): void {
  const ov = document.createElement('div');
  ov.id = 'logged-out';
  const box = document.createElement('div');
  box.className = 'logged-out-box';
  const title = document.createElement('div');
  title.className = 'logged-out-title';
  title.textContent = '🔒 ログアウトされました';
  const msg = document.createElement('div');
  msg.className = 'logged-out-msg';
  msg.textContent = reason;
  box.append(title, msg);
  ov.appendChild(box);
  document.body.appendChild(ov);
}

/** モバイル: 左右パネルをドロワーとして開閉する。 */
function setupDrawers(): void {
  const left = el('left');
  const right = el('right');
  const backdrop = el('backdrop');
  const closeAll = (): void => {
    left.classList.remove('open');
    right.classList.remove('open');
    backdrop.classList.remove('show');
  };
  const toggle = (panel: HTMLElement): void => {
    const willOpen = !panel.classList.contains('open');
    closeAll();
    if (willOpen) {
      panel.classList.add('open');
      backdrop.classList.add('show');
    }
  };
  el('btn-left').addEventListener('click', () => toggle(left));
  el('btn-right').addEventListener('click', () => toggle(right));
  backdrop.addEventListener('click', closeAll);
}

void main();
