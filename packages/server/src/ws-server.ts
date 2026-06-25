// WS サーバ。world スナップショットとログを全クライアントへ配信し、
// クライアントからの扇動/沈静化コマンドを受ける。

import { WebSocketServer, WebSocket } from 'ws';
import { toWire, type World, type ServerMessage, type ClientMessage } from '@pagus/sim';

export interface WsHandlers {
  onIncite(): void;
  onCalm(): void;
  onVote(pick: string): void;
}

export class GameWsServer {
  private readonly wss: WebSocketServer;
  private lastSnapshot: string | null = null;

  constructor(port: number, private readonly h: WsHandlers) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    // 接続直後に最新スナップショットと現在の接続人数を送る。
    if (this.lastSnapshot) ws.send(this.lastSnapshot);
    this.broadcastPlayers();
    ws.on('close', () => this.broadcastPlayers());
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return; // 不正な JSON は無視
      }
      if (msg.t === 'incite') this.h.onIncite();
      else if (msg.t === 'calm') this.h.onCalm();
      else if (msg.t === 'vote') this.h.onVote(msg.pick);
    });
  }

  /** 現在の OPEN な接続数を全員へ配る。 */
  private broadcastPlayers(): void {
    let count = 0;
    for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) count++;
    const msg: ServerMessage = { t: 'players', count };
    this.fanout(JSON.stringify(msg));
  }

  broadcastSnapshot(world: World): void {
    const msg: ServerMessage = { t: 'snapshot', world: toWire(world) };
    this.lastSnapshot = JSON.stringify(msg);
    this.fanout(this.lastSnapshot);
  }

  broadcastLog(phase: World['phase'], text: string): void {
    const msg: ServerMessage = { t: 'log', phase, text };
    this.fanout(JSON.stringify(msg));
  }

  private fanout(serialized: string): void {
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(serialized);
    }
  }
}
