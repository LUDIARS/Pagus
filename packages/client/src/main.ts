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
import { connect, type Conn } from './ws-client.js';
import { getUserId, enablePush } from './push-client.js';

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
  const chronicle = new ChronicleView(el('chronicle'), el('chronicle-body'), el('hist-btn'), el('chronicle-close'));

  const userId = getUserId();
  let conn: Conn;
  const trial = new TrialPanel(el('trial'), (pick) => conn.send({ t: 'vote', pick, userId }));

  const verdict = el('verdict');
  // 有罪/無罪ボタンは「殺す/活かす」を決める fate 段階でのみ出す (foolish=被告選びは右パネル)。
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
      verdict.classList.toggle('show', showVerdict(world));
    },
    onLog: (phase, text) => log.add(phase, text),
    onStatus: (status) => hud.setStatus(status),
    onPlayers: (count) => vstatus.setPlayers(count),
    onTrialLines: (incidentId, lines) => stage.setTrialLines(incidentId, lines),
    onLlm: (info) => llmPanel.setInfo(info),
    onChronicle: (entries) => chronicle.setEntries(entries),
  });

  el('incite').addEventListener('click', () => conn.send({ t: 'incite' }));
  el('calm').addEventListener('click', () => conn.send({ t: 'calm' }));

  // 裁判の票は中央の有罪/無罪に一本化。
  //   有罪 = 殺す(kill) 投票 + 扇動、無罪 = 活かす(spare) 投票 + 沈静化。
  //   同時にプレイヤーの罵倒/擁護を吹き出しで表示。投票し直しは server 側で前票を差し替え。
  el('v-guilty').addEventListener('click', () => {
    conn.send({ t: 'vote', pick: 'kill', userId });
    conn.send({ t: 'incite' });
    stage.playerVerdict('guilty');
  });
  el('v-innocent').addEventListener('click', () => {
    conn.send({ t: 'vote', pick: 'spare', userId });
    conn.send({ t: 'calm' });
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
