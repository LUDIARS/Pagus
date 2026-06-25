// WS 接続。server からの snapshot/log を受け、扇動/沈静化コマンドを送る。自動再接続。

import type { WireWorld, ServerMessage, ClientMessage, Phase } from '@pagus/sim';

export interface WsHandlers {
  onSnapshot(world: WireWorld): void;
  onLog(phase: Phase, text: string): void;
  onStatus(status: string): void;
  onPlayers(count: number): void;
}

export interface Conn {
  send(msg: ClientMessage): void;
}

export function connect(url: string, h: WsHandlers): Conn {
  let ws: WebSocket | null = null;

  const open = (): void => {
    ws = new WebSocket(url);
    ws.onopen = () => h.onStatus('● 接続');
    ws.onerror = () => h.onStatus('● エラー');
    ws.onclose = () => {
      h.onStatus('○ 切断 (再接続…)');
      setTimeout(open, 1500);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === 'snapshot') h.onSnapshot(msg.world);
      else if (msg.t === 'log') h.onLog(msg.phase, msg.text);
      else if (msg.t === 'players') h.onPlayers(msg.count);
    };
  };
  open();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
  };
}
