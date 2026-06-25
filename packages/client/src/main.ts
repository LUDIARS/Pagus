// Pagus client エントリ。WS に繋ぎ、ステージ (村/裁判) と左右パネル・ログを更新する。

import { StageView } from './stage-view.js';
import { Radar } from './radar.js';
import { Hud } from './hud.js';
import { TrialPanel } from './trial-panel.js';
import { IncidentPanel } from './incident-panel.js';
import { VillageStatus } from './village-status.js';
import { LogOverlay } from './log-overlay.js';
import { connect, type Conn } from './ws-client.js';

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

  let conn: Conn;
  const trial = new TrialPanel(el('trial'), (pick) => conn.send({ t: 'vote', pick }));

  conn = connect(WS_URL, {
    onSnapshot: (world) => {
      stage.update(world);
      radar.update(world.reputation);
      hud.updateCalendar(world);
      trial.update(world);
      incident.update(world);
      vstatus.update(world);
    },
    onLog: (phase, text) => log.add(phase, text),
    onStatus: (status) => hud.setStatus(status),
    onPlayers: (count) => vstatus.setPlayers(count),
  });

  el('incite').addEventListener('click', () => conn.send({ t: 'incite' }));
  el('calm').addEventListener('click', () => conn.send({ t: 'calm' }));

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
