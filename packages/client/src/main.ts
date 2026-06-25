// Pagus client エントリ。WS に繋ぎ、村ビュー / 徳目レーダー / HUD を更新する。

import { VillageView } from './village-view.js';
import { Radar } from './radar.js';
import { Hud } from './hud.js';
import { TrialPanel } from './trial-panel.js';
import { connect, type Conn } from './ws-client.js';

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? 'ws://localhost:4310';

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} が見つかりません`);
  return node;
}

async function main(): Promise<void> {
  const view = new VillageView();
  await view.mount(el('village'));
  const radar = new Radar(el('radar') as HTMLCanvasElement);
  const hud = new Hud(el('hud'), el('log'), el('status'));

  let conn: Conn;
  const trial = new TrialPanel(el('trial'), (pick) => conn.send({ t: 'vote', pick }));

  conn = connect(WS_URL, {
    onSnapshot: (world) => {
      view.update(world);
      radar.update(world.reputation);
      hud.updateCalendar(world);
      trial.update(world);
    },
    onLog: (phase, text) => hud.addLog(phase, text),
    onStatus: (status) => hud.setStatus(status),
  });

  el('incite').addEventListener('click', () => conn.send({ t: 'incite' }));
  el('calm').addEventListener('click', () => conn.send({ t: 'calm' }));
}

void main();
