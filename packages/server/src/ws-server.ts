// WS サーバ。world スナップショットとログを全クライアントへ配信し、
// クライアントからのプレイヤー操作 (扇動/制裁/応援/投票) コマンドを受ける。
// カルマ/善性は userId ごとに持つため、接続ごとに userId を保持し
// per-connection で playerState / commandRejected を送る。

import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  toWire,
  type World,
  type ServerMessage,
  type ClientMessage,
  type TrialLine,
  type LlmInfo,
  type ChronicleEntry,
  type PlayerActionEntry,
} from '@pagus/sim';
import type { PlayerStateSnapshot } from './player-state.js';

export interface WsHandlers {
  onHello(userId: string): void;
  onIncite(targetId: string, rumorAboutId: string | undefined, userId: string): void;
  onSanction(targetId: string, userId: string): void;
  onCheer(targetId: string, userId: string): void;
  onVote(pick: string, userId?: string): void;
}

export class GameWsServer {
  private readonly wss: WebSocketServer;
  private lastSnapshot: string | null = null;
  private llmInfo: LlmInfo | null = null;
  private chronicle: ChronicleEntry[] = [];
  private playerActions: PlayerActionEntry[] = [];
  /** 接続 → その接続を名乗った userId。per-connection 配信の宛先解決に使う。 */
  private readonly connUser = new Map<WebSocket, string>();

  /** HTTP サーバに相乗りして WS を待ち受ける (HTTP API と同一ポート/同一オリジン)。 */
  constructor(server: HttpServer, private readonly h: WsHandlers) {
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  /** 稼働中の LLM 構成を設定 (接続時に各クライアントへ送る)。 */
  setLlmInfo(info: LlmInfo): void {
    this.llmInfo = info;
  }

  /** 村の歴史を更新し、全クライアントへ配る。 */
  updateChronicle(entries: ChronicleEntry[]): void {
    this.chronicle = entries;
    this.fanout(JSON.stringify({ t: 'chronicle', entries } satisfies ServerMessage));
  }

  private onConnection(ws: WebSocket): void {
    // 接続直後に最新スナップショット・接続人数・LLM 構成・村の歴史・人間の行動記録を送る。
    if (this.lastSnapshot) ws.send(this.lastSnapshot);
    if (this.llmInfo) ws.send(JSON.stringify({ t: 'llm', info: this.llmInfo } satisfies ServerMessage));
    if (this.chronicle.length > 0) {
      ws.send(JSON.stringify({ t: 'chronicle', entries: this.chronicle } satisfies ServerMessage));
    }
    ws.send(JSON.stringify({ t: 'playerActions', entries: this.playerActions } satisfies ServerMessage));
    this.broadcastPlayers();
    ws.on('close', () => {
      this.connUser.delete(ws);
      this.broadcastPlayers();
    });
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return; // 不正な JSON は無視
      }
      this.handle(ws, msg);
    });
  }

  /** 接続にこの userId を結びつける (hello / 各コマンドの userId で更新)。 */
  private bind(ws: WebSocket, userId: string | undefined): void {
    if (userId && userId.length > 0) this.connUser.set(ws, userId);
  }

  private handle(ws: WebSocket, msg: ClientMessage): void {
    if (msg.t === 'hello') {
      this.bind(ws, msg.userId);
      this.h.onHello(msg.userId);
    } else if (msg.t === 'incite') {
      this.bind(ws, msg.userId);
      this.h.onIncite(msg.targetId, msg.rumorAboutId, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'sanction') {
      this.bind(ws, msg.userId);
      this.h.onSanction(msg.targetId, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'cheer') {
      this.bind(ws, msg.userId);
      this.h.onCheer(msg.targetId, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'vote') {
      this.bind(ws, msg.userId);
      this.h.onVote(msg.pick, msg.userId);
    }
  }

  /** コマンドの userId、無ければ接続に紐付いた userId、それも無ければ 'anon'。 */
  private resolveUser(ws: WebSocket, userId: string | undefined): string {
    if (userId && userId.length > 0) return userId;
    return this.connUser.get(ws) ?? 'anon';
  }

  /** 特定 userId の全接続へ playerState を送る (per-connection)。 */
  sendPlayerState(userId: string, state: PlayerStateSnapshot): void {
    const msg: ServerMessage = {
      t: 'playerState',
      karma: state.karma,
      virtue: state.virtue,
      sanctionCost: state.sanctionCost,
      canCheerInMs: state.canCheerInMs,
    };
    this.sendToUser(userId, JSON.stringify(msg));
  }

  /** 特定 userId の全接続へ commandRejected を送る。 */
  sendRejected(userId: string, reason: string): void {
    const msg: ServerMessage = { t: 'commandRejected', reason };
    this.sendToUser(userId, JSON.stringify(msg));
  }

  /** 人間の行動記録を更新し、全クライアントへ配る (§8)。 */
  broadcastPlayerActions(entries: PlayerActionEntry[]): void {
    this.playerActions = entries;
    this.fanout(JSON.stringify({ t: 'playerActions', entries } satisfies ServerMessage));
  }

  private sendToUser(userId: string, serialized: string): void {
    for (const [ws, uid] of this.connUser) {
      if (uid === userId && ws.readyState === WebSocket.OPEN) ws.send(serialized);
    }
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

  /** 裁判の糾弾セリフ (server 生成/再利用) を配る。 */
  broadcastTrialLines(incidentId: string, lines: TrialLine[]): void {
    const msg: ServerMessage = { t: 'trialLines', incidentId, lines };
    this.fanout(JSON.stringify(msg));
  }

  private fanout(serialized: string): void {
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(serialized);
    }
  }
}
