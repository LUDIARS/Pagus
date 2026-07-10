// Pagus client エントリ。WS に繋ぎ、ステージ (村/裁判) と左右パネル・ログを更新する。

import { StageView } from './stage-view.js';
import { Radar } from './radar.js';
import { Hud } from './hud.js';
import { TrialPanel } from './trial-panel.js';
import { IncidentPanel } from './incident-panel.js';
import { VillageStatus } from './village-status.js';
import { LogOverlay } from './log-overlay.js';
import { ChronicleView } from './chronicle-view.js';
import { StatusPanel } from './status-panel.js';
import { PlayerControls, type ActionType } from './player-controls.js';
import { HeckleButtons } from './heckle-buttons.js';
import { TestifyPanel } from './testify-panel.js';
import { CardPanel } from './card-panel.js';
import { EconomyPanel } from './economy-panel.js';
import { GovernancePanel } from './governance-panel.js';
import { SpectaclePanel } from './spectacle-panel.js';
import { LeaderboardPanel } from './leaderboard-panel.js';
import { AccountPanel, AccountSettingsPanel } from './account-panel.js';
import { ItemPanel } from './item-panel.js';
import { ResidentGachaPanel, ResidentPanel, type ResidentPanelHandlers } from './resident-panel.js';
import { ActionOverlay } from './action-overlay.js';
import { ChatPanel } from './chat-panel.js';
import { connect, type Conn } from './ws-client.js';
import { getUserId, getUserName, setUserId, setUserName, enablePush } from './push-client.js';
import { lockPageZoom } from './lock-page-zoom.js';

lockPageZoom();

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

let eventTitleTimer: number | null = null;

function showEventTitle(title: string, subtitle: string | undefined, kind: 'mystery' | 'trial' | 'life'): void {
  const root = document.getElementById('event-title-call');
  const titleEl = document.getElementById('event-title-main');
  const subEl = document.getElementById('event-title-sub');
  if (!root || !titleEl || !subEl) return;
  titleEl.textContent = title;
  subEl.textContent = subtitle ?? (kind === 'trial' ? '公開裁判' : kind === 'life' ? '村の祝い' : '事件の幕開け');
  root.classList.remove('mystery', 'trial', 'life');
  root.classList.add(kind, 'show');
  if (eventTitleTimer !== null) window.clearTimeout(eventTitleTimer);
  eventTitleTimer = window.setTimeout(() => {
    root.classList.remove('show');
    eventTitleTimer = null;
  }, 3200);
}

async function main(): Promise<void> {
  const stage = new StageView();
  await stage.mount(el('stage'));

  const radar = new Radar(el('radar') as HTMLCanvasElement);
  const hud = new Hud(el('hud'), el('status'));
  const log = new LogOverlay(el('village-log'));
  const incident = new IncidentPanel(el('incident-info'));
  const vstatus = new VillageStatus(el('vstatus'));
  const ruleHandlers = {
    // しきたり改定 (§2): カルマを払って村のルールを増減。
    onAddRule: (text: string) => conn.send({ t: 'addRule', text, userId }),
    onRemoveRule: (ruleId: string) => conn.send({ t: 'removeRule', ruleId, userId }),
  };
  const chronicle = new ChronicleView(el('chronicle'), el('chronicle-body'), el('hist-btn'), el('chronicle-close'), undefined, {
    tabs: ['highlight', 'events', 'logs', 'trial', 'life', 'rules', 'villagers', 'actions', 'other'],
  });
  const interventionRules = new ChronicleView(null, el('intervention-rules'), null, null, {
    ...ruleHandlers,
  }, {
    tabs: ['rules'],
    initialTab: 'rules',
    showTabs: false,
  });
  const villageRules = new ChronicleView(null, el('village-rules'), null, null, undefined, {
    tabs: ['rules'],
    initialTab: 'rules',
    showTabs: false,
  });
  const statusPanel = new StatusPanel(el('status-head'), el('status-body'));

  const userId = getUserId();
  const userName = getUserName();
  let conn: Conn;
  const trial = new TrialPanel(el('trial'), (pick) => {
    conn.send({ t: 'vote', pick, userId });
    if (pick === 'kill' || pick === 'spare') stage.playerVerdict(pick === 'kill' ? 'guilty' : 'innocent');
  });
  // スコアボード (§4): 称号・陣営・綱引き。陣営選択を送る。
  const leaderboard = new LeaderboardPanel(el('leaderboard'), userId);

  // アカウント (§v1.3-F): 課金モック。
  const account = new AccountPanel(el('account'), {
    onTopup: (amount) => conn.send({ t: 'topup', amount, userId }),
  });
  // 設定内アカウント: ユーザー名 / ユーザーコード / 別端末ログイン。
  const accountSettings = new AccountSettingsPanel(el('account-settings'), userId, userName, {
    onLogin: (code) => {
      // ユーザーコードで束ね直す → ローカルの userId を差し替えて全パネルを貼り直す (reload)。
      conn.send({ t: 'login', code });
      setUserId(code);
      setTimeout(() => location.reload(), 400); // login 送信を flush してから貼り直す
    },
    onUserName: (name) => {
      const normalized = setUserName(name);
      accountSettings.setUserName(normalized, true);
      conn.send({ t: 'setUserName', name: normalized ?? '', userId });
    },
  });

  // プレイヤー行動パネル (§4): 課金以外はすべて介入タブへまとめる。
  // 扇動は noun (悪口の主 rumorAboutId) を任意で伴う (§4.2)。未選択なら省略。
  const sendAction = (type: ActionType, targetId: string, rumorAboutId?: string): void => {
    if (type === 'incite') {
      conn.send(rumorAboutId ? { t: 'incite', targetId, rumorAboutId, userId } : { t: 'incite', targetId, userId });
    } else if (type === 'sanction') conn.send({ t: 'sanction', targetId, userId });
    else conn.send({ t: 'cheer', targetId, userId });
    // 行動の手応え: 対象どうぶつに即リアクション吹き出しを出す (扇動のリアクション無し問題への対応)。
    stage.reactToAction(targetId, type);
  };
  const interventionControls = new PlayerControls(el('interventions'), {
    onAction: sendAction,
    onChampion: (targetId) => {
      conn.send({ t: 'champion', targetId, userId });
      stage.reactToAction(targetId, 'champion');
    },
    onVerdict: (pick) => {
      conn.send({ t: 'vote', pick, userId });
      stage.playerVerdict(pick === 'kill' ? 'guilty' : 'innocent');
    },
    // 贈り物 (§v1.4-A): 差し入れ/毒饅頭を手渡す。
    onGift: (targetId, kind) => {
      conn.send({ t: 'gift', targetId, kind, userId });
      stage.reactToAction(targetId, kind === 'treat' ? 'gift-treat' : 'gift-poison');
    },
    // 噂の増幅 (§v1.4-A'): 対象の噂を近傍へ言いふらす。
    onFanFlames: (targetId) => {
      conn.send({ t: 'fanFlames', targetId, userId });
      stage.reactToAction(targetId, 'fanFlames');
    },
  }, { commands: ['incite', 'sanction', 'cheer', 'champion', 'gift-treat', 'gift-poison', 'fanFlames'], showVerdict: false });

  // 野次 (§v1.4-A): 事件 (承) の進行中だけ中央に出る 煽る/なだめる ボタン。
  const heckle = new HeckleButtons(el('heckle'), (side) => {
    conn.send({ t: 'heckle', side, userId });
    stage.reactToHeckle(side);
  });

  // 証言 (§v1.4-A): 裁判の運命段階に 1 グループ分の票を上乗せする。
  const testify = new TestifyPanel(el('testify'), (stance, text) => {
    conn.send(text !== undefined ? { t: 'testify', stance, text, userId } : { t: 'testify', stance, userId });
    stage.playerTestify(stance, text);
  });

  // イベントカード: 月次配布カードを1枚消費して server 側でガチャ効果を起こす。
  const cards = new CardPanel(el('cards'), {
    onDraw: () => conn.send({ t: 'eventCard', userId }),
  });

  // アイテムパネル (§16): 人手でフィールドにアイテム配置 (ランダム/貴金属/薬物)。推しに直送も可。
  const items = new ItemPanel(el('items'), {
    onPlace: (kind, toChampion) => conn.send({ t: 'placeItem', kind, toChampion, userId }),
    // 場所介入 (§v1.4-A'): 荒らす/清める。
    onSpot: (place, mode) => conn.send({ t: 'spot', place, mode, userId }),
  }, { showSpot: false });

  const residentHandlers: ResidentPanelHandlers = {
    onGacha: (kind) => conn.send({ t: 'villagerGacha', kind, userId }),
  };
  new ResidentGachaPanel(el('resident-gacha'), residentHandlers);
  const residents = new ResidentPanel(el('residents'), residentHandlers, { showGacha: false });
  stage.setVillagerTapHandler((villagerId) => residents.showVillagerDetails(villagerId));

  // 経済パネル (§v1.3-B): 保険 / 闇市 / オークション (送金・銀行は廃止)。
  const economy = new EconomyPanel(el('economy'), {
    onInsure: (targetId, premium) => conn.send({ t: 'insure', targetId, premium, userId }),
    onBuyMarket: (item, args) => conn.send({ t: 'buyMarket', item, userId, ...args }),
    onBid: (lotId, amount) => conn.send({ t: 'bid', lotId, amount, userId }),
  });

  // 政治パネル (§v1.3-C + §17): 村長(村人選挙/世論/リコール) / 法案 / 革命 / 戒厳令 / 村基金。
  const governance = new GovernancePanel(el('governance'), {
    onRecallMayor: () => conn.send({ t: 'recallMayor', userId }),
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
  }, { readOnly: true });

  const godChat = new ChatPanel(
    el('god-chat'),
    userId,
    (text) => conn.send({ t: 'chat', text, userId, channel: 'god' }),
    { title: null, placeholder: '神の声を落とす', emptyText: 'まだ神の声はありません。' },
  );
  const humanChat = new ChatPanel(
    el('human-chat'),
    userId,
    (text) => conn.send({ t: 'chat', text, userId, channel: 'human' }),
    { title: null, placeholder: '人間だけに送る', emptyText: 'まだ人間同士の会話はありません。' },
  );
  const dmChat = new ChatPanel(
    el('dm-chat'),
    userId,
    () => undefined,
    { title: null, readOnly: true, emptyText: '住民とのDMは未配線です。' },
  );

  // 統合アクションオーバーレイ (§v1.3-E): 左ペインに埋め込む介入パネル。
  // 課金以外の操作群 (介入/カード/村のしきたり) をタブ式に集約する。
  const overlay = new ActionOverlay(el('action-overlay'), el('ao-header'), el('ao-tabs'), null, el('ao-backdrop'), { embedded: true });

  conn = connect(WS_URL, {
    onSnapshot: (world) => {
      log.setDate(`${world.calendar.month}月${world.calendar.dayOfMonth}日`);
      stage.update(world);
      radar.update(world.reputation);
      hud.updateCalendar(world);
      trial.update(world);
      incident.update(world);
      vstatus.update(world);
      chronicle.setWorld(world);
      interventionRules.setWorld(world);
      villageRules.setWorld(world);
      interventionControls.setWorld(world);
      cards.setWorld(world);
      items.setWorld(world);
      residents.setWorld(world);
      economy.setWorld(world);
      governance.setWorld(world); // 村長/世論調査 (§17) は snapshot から
      spectacle.setWorld(world);
      heckle.setWorld(world);
      testify.setWorld(world);
    },
    onLog: (phase, text) => log.add(phase, text),
    onStatus: (status) => {
      hud.setStatus(status);
      // 接続確立時にユーザを名乗る (per-user カルマ push 用)。
      if (status.startsWith('●') && status.includes('接続')) {
        const currentName = getUserName();
        conn.send(currentName ? { t: 'hello', userId, userName: currentName } : { t: 'hello', userId });
      }
    },
    onPlayers: (count) => vstatus.setPlayers(count),
    onTrialLines: (incidentId, lines) => stage.setTrialLines(incidentId, lines),
    onTrialVoices: (incidentId, voices) => stage.setTrialVoices(incidentId, voices),
    onLlm: () => undefined,
    onChronicle: (entries) => {
      chronicle.setEntries(entries);
      villageRules.setEntries(entries);
    },
    onEventTitle: (title, subtitle, kind) => showEventTitle(title, subtitle, kind),
    // テーマパック (§v1.4-D): 語彙を各所へ適用し、wholesome では死刑ボタンを隠す。
    onTheme: (_pack, _moral, lexicon) => {
      stage.setTheme(lexicon);
      vstatus.setTheme(lexicon);
      interventionControls.setPoisonLabel(lexicon.giftPoisonLabel);
    },
    onSysStatus: (s) => statusPanel.setStatus(s),
    onPlayerState: (state) => {
      interventionControls.setState(state);
      heckle.setState(state.heckleCost, state.canHeckleInMs);
      testify.setState(state.testifyCost);
      items.setCosts(state.spotCost);
      cards.setKarma(state.karma);
      cards.setInventory(state.eventCards);
      economy.setState(state.karma);
      account.setSpent(state.spent);
      setUserName(state.userName);
      accountSettings.setUserName(state.userName);
      // 常時ヘッダ (カルマ/善性/課金/推し/応援クールダウン) を更新。
      overlay.setPlayerState({
        karma: state.karma,
        virtue: state.virtue,
        spent: state.spent,
        championId: state.championId,
        ...(state.championName !== undefined ? { championName: state.championName } : {}),
        canCheerInMs: state.canCheerInMs,
        canIntervene: state.canIntervene,
      });
    },
    onCommandRejected: (reason) => showToast(`⚠ ${reason}`),
    onLoggedOut: (reason) => {
      conn.close(); // 再接続を止める (握り潰さない)
      showLoggedOut(reason);
    },
    onPlayerActions: (entries) => {
      chronicle.setActions(entries);
      villageRules.setActions(entries);
    },
    onLeaderboard: (s) => {
      leaderboard.setLeaderboard(s);
      residents.setLeaderboard(s.players);
    },
    onAuction: (lots) => economy.setAuction(lots),
    onLaws: (items) => governance.setLaws(items),
    onRevolt: (active, incite, suppress, endsInMs) => governance.setRevolt(active, incite, suppress, endsInMs),
    onMartial: (mode) => governance.setMartial(mode),
    onFund: (amount, threshold) => governance.setFund(amount, threshold),
    onHighlights: (cards) => spectacle.setHighlights(cards),
    onChat: (messages) => {
      godChat.setMessages(messages.filter((msg) => msg.channel === 'god'));
      humanChat.setMessages(messages.filter((msg) => msg.channel === 'human'));
      dmChat.setMessages(messages.filter((msg) => msg.channel === 'dm'));
    },
    onMvp: (villagerId, name) => spectacle.setMvp(villagerId, name),
    onRaid: (active, villainName, hp, hpMax, endsInMs) => spectacle.setRaid(active, villainName, hp, hpMax, endsInMs),
    onSeason: (num, winner, leaderboard) => spectacle.setSeason(num, winner, leaderboard),
  });

  // 🔔 通知: 裁判が始まったら端末へ push (接続を閉じていても投票を促す)。
  const pushBtn = el('push-btn');
  const settingsBtn = el('settings-btn');
  const settingsMenu = el('settings-menu');
  const settingsClose = el('settings-close');
  const setSettingsOpen = (open: boolean): void => {
    settingsMenu.classList.toggle('show', open);
  };
  settingsBtn.addEventListener('click', () => setSettingsOpen(!settingsMenu.classList.contains('show')));
  settingsClose.addEventListener('click', () => setSettingsOpen(false));
  settingsMenu.addEventListener('click', (event) => {
    if (event.target === settingsMenu) setSettingsOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setSettingsOpen(false);
  });
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

  setupAccountOverlay();
  setupLogTabs();
  setupRightTabs();
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

/** 課金は上部ヘッダーの専用オーバーレイで開閉する。 */
function setupAccountOverlay(): void {
  const openBtn = el('account-btn');
  const overlay = el('account-overlay');
  const closeBtn = el('account-close');
  const setOpen = (open: boolean): void => {
    overlay.classList.toggle('show', open);
  };
  openBtn.addEventListener('click', () => setOpen(true));
  closeBtn.addEventListener('click', () => setOpen(false));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
}

/** 右ペインの情報群をタブで切り替える。 */
function setupRightTabs(): void {
  const right = el('right');
  const buttons = Array.from(right.querySelectorAll<HTMLButtonElement>('[data-right-tab]'));
  const panels = Array.from(right.querySelectorAll<HTMLElement>('[data-right-panel]'));
  const select = (id: string): void => {
    for (const button of buttons) button.classList.toggle('active', button.dataset.rightTab === id);
    for (const panel of panels) panel.hidden = panel.dataset.rightPanel !== id;
  };
  for (const button of buttons) {
    button.addEventListener('click', () => select(button.dataset.rightTab ?? 'village'));
  }
  select(buttons.find((button) => button.classList.contains('active'))?.dataset.rightTab ?? 'village');
}

/** 中央下ログの「村の様子 / チャット」タブを切り替える。 */
function setupLogTabs(): void {
  const root = el('log');
  const toggle = el('log-toggle') as HTMLButtonElement;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-log-tab]'));
  const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-log-panel]'));
  let closed = false;
  let drag:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        left: number;
        top: number;
        width: number;
        height: number;
      }
    | null = null;
  let previousUserSelect = '';

  const setClosed = (next: boolean): void => {
    closed = next;
    root.classList.toggle('log-closed', closed);
    toggle.textContent = closed ? '開' : '×';
    const label = closed ? 'チャットを開く' : 'チャットを閉じる';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  };

  const select = (id: string): void => {
    for (const button of buttons) button.classList.toggle('active', button.dataset.logTab === id);
    for (const panel of panels) panel.hidden = panel.dataset.logPanel !== id;
  };
  const canDrag = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    if (target.closest('button,input,textarea,select,a')) return false;
    return Boolean(target.closest('[data-log-panel]'));
  };
  const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

  root.addEventListener('pointerdown', (event) => {
    if (closed || event.button !== 0 || !canDrag(event.target)) return;
    const rootRect = root.getBoundingClientRect();
    const centerRect = el('center').getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rootRect.left - centerRect.left,
      top: rootRect.top - centerRect.top,
      width: rootRect.width,
      height: rootRect.height,
    };
    root.style.left = `${drag.left}px`;
    root.style.top = `${drag.top}px`;
    root.style.width = `${drag.width}px`;
    root.style.height = `${drag.height}px`;
    root.style.bottom = 'auto';
    root.style.transform = 'none';
    previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    root.classList.add('log-dragging');
    root.setPointerCapture(event.pointerId);
  });
  root.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const centerRect = el('center').getBoundingClientRect();
    const nextLeft = clamp(drag.left + event.clientX - drag.startX, 8, centerRect.width - drag.width - 8);
    const nextTop = clamp(drag.top + event.clientY - drag.startY, 8, centerRect.height - drag.height - 8);
    root.style.left = `${nextLeft}px`;
    root.style.top = `${nextTop}px`;
  });
  const stopDrag = (event: PointerEvent): void => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    root.classList.remove('log-dragging');
    document.body.style.userSelect = previousUserSelect;
    drag = null;
  };
  root.addEventListener('pointerup', stopDrag);
  root.addEventListener('pointercancel', stopDrag);
  toggle.addEventListener('click', () => setClosed(!closed));
  for (const button of buttons) {
    button.addEventListener('click', () => select(button.dataset.logTab ?? 'village'));
  }
  setClosed(false);
  select(buttons.find((button) => button.classList.contains('active'))?.dataset.logTab ?? 'village');
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
