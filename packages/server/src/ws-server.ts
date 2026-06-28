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
  type LeaderboardEntry,
  type Faction,
  type CardName,
  type MarketItem,
  type AuctionLotView,
  type LawView,
  type MartialMode,
} from '@pagus/sim';
import type { PlayerStateSnapshot } from './player-state.js';

/** カード介入 (§v1.3-A) の引数 (card 別に必要分だけ伴う)。 */
export interface CardArgs {
  targetId?: string;
  targetId2?: string;
  kind?: string;
  text?: string;
}

/** 闇市購入 (§v1.3-B ⑤) の引数 (item 別に必要分だけ伴う)。 */
export interface MarketArgs {
  targetId?: string;
  targetId2?: string;
  kind?: string;
}

/** 状態パネル (§7) の sysStatus メッセージ形。 */
type SysStatusMessage = Extract<ServerMessage, { t: 'sysStatus' }>;

export interface WsHandlers {
  onHello(userId: string): void;
  onIncite(targetId: string, rumorAboutId: string | undefined, userId: string): void;
  onSanction(targetId: string, userId: string): void;
  onCheer(targetId: string, userId: string): void;
  onVote(pick: string, userId?: string): void;
  onChampion(targetId: string, userId: string): void;
  onAddRule(text: string, userId: string): void;
  onRemoveRule(ruleId: string, userId: string): void;
  onBet(pick: 'death' | 'educate', amount: number, userId: string): void;
  onFaction(side: Faction, userId: string): void;
  onCard(card: CardName, args: CardArgs, userId: string): void;
  onTransfer(toUserId: string, amount: number, userId: string): void;
  onDeposit(amount: number, userId: string): void;
  onWithdraw(amount: number, userId: string): void;
  onInsure(targetId: string, premium: number, userId: string): void;
  onBuyMarket(item: MarketItem, args: MarketArgs, userId: string): void;
  onBid(lotId: string, amount: number, userId: string): void;
  // 政治パック (§v1.3-C)。
  onVoteMayor(target: string, userId: string): void;
  onProposeLaw(text: string, userId: string): void;
  onVoteLaw(lawId: string, approve: boolean, userId: string): void;
  onRevolt(side: 'incite' | 'suppress', userId: string): void;
  onMartial(mode: MartialMode, userId: string): void;
}

export class GameWsServer {
  private readonly wss: WebSocketServer;
  private lastSnapshot: string | null = null;
  private llmInfo: LlmInfo | null = null;
  private chronicle: ChronicleEntry[] = [];
  private playerActions: PlayerActionEntry[] = [];
  /** リーダーボード (§4.3) の最新値。接続時に現値を送る。 */
  private leaderboard: Extract<ServerMessage, { t: 'leaderboard' }> | null = null;
  /** 状態パネル (§7) の最新値。接続時に現値を送る。 */
  private sysStatus: SysStatusMessage | null = null;
  /** オークション (§v1.3-B ②) の最新ロット状態。接続時に現値を送る。 */
  private auction: Extract<ServerMessage, { t: 'auction' }> | null = null;
  /** 政治パック (§v1.3-C) の最新状態 (村長/法案/革命/戒厳令/基金)。接続時に現値を送る。 */
  private mayor: Extract<ServerMessage, { t: 'mayor' }> | null = null;
  private laws: Extract<ServerMessage, { t: 'laws' }> | null = null;
  private revolt: Extract<ServerMessage, { t: 'revolt' }> | null = null;
  private martial: Extract<ServerMessage, { t: 'martial' }> | null = null;
  private fund: Extract<ServerMessage, { t: 'fund' }> | null = null;
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
    if (this.sysStatus) ws.send(JSON.stringify(this.sysStatus));
    if (this.leaderboard) ws.send(JSON.stringify(this.leaderboard));
    if (this.auction) ws.send(JSON.stringify(this.auction));
    if (this.mayor) ws.send(JSON.stringify(this.mayor));
    if (this.laws) ws.send(JSON.stringify(this.laws));
    if (this.revolt) ws.send(JSON.stringify(this.revolt));
    if (this.martial) ws.send(JSON.stringify(this.martial));
    if (this.fund) ws.send(JSON.stringify(this.fund));
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
    } else if (msg.t === 'champion') {
      this.bind(ws, msg.userId);
      this.h.onChampion(msg.targetId, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'addRule') {
      this.bind(ws, msg.userId);
      this.h.onAddRule(msg.text, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'removeRule') {
      this.bind(ws, msg.userId);
      this.h.onRemoveRule(msg.ruleId, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'bet') {
      this.bind(ws, msg.userId);
      this.h.onBet(msg.pick, msg.amount, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'faction') {
      this.bind(ws, msg.userId);
      this.h.onFaction(msg.side, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'card') {
      this.bind(ws, msg.userId);
      // exactOptionalPropertyTypes: 値があるキーだけ詰める。
      const args: CardArgs = {};
      if (msg.targetId !== undefined) args.targetId = msg.targetId;
      if (msg.targetId2 !== undefined) args.targetId2 = msg.targetId2;
      if (msg.kind !== undefined) args.kind = msg.kind;
      if (msg.text !== undefined) args.text = msg.text;
      this.h.onCard(msg.card, args, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'transfer') {
      this.bind(ws, msg.userId);
      this.h.onTransfer(msg.toUserId, msg.amount, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'deposit') {
      this.bind(ws, msg.userId);
      this.h.onDeposit(msg.amount, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'withdraw') {
      this.bind(ws, msg.userId);
      this.h.onWithdraw(msg.amount, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'insure') {
      this.bind(ws, msg.userId);
      this.h.onInsure(msg.targetId, msg.premium, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'buyMarket') {
      this.bind(ws, msg.userId);
      // exactOptionalPropertyTypes: 値があるキーだけ詰める。
      const args: MarketArgs = {};
      if (msg.targetId !== undefined) args.targetId = msg.targetId;
      if (msg.targetId2 !== undefined) args.targetId2 = msg.targetId2;
      if (msg.kind !== undefined) args.kind = msg.kind;
      this.h.onBuyMarket(msg.item, args, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'bid') {
      this.bind(ws, msg.userId);
      this.h.onBid(msg.lotId, msg.amount, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'voteMayor') {
      this.bind(ws, msg.userId);
      this.h.onVoteMayor(msg.target, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'proposeLaw') {
      this.bind(ws, msg.userId);
      this.h.onProposeLaw(msg.text, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'voteLaw') {
      this.bind(ws, msg.userId);
      this.h.onVoteLaw(msg.lawId, msg.approve, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'revolt') {
      this.bind(ws, msg.userId);
      this.h.onRevolt(msg.side, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'martial') {
      this.bind(ws, msg.userId);
      this.h.onMartial(msg.mode, this.resolveUser(ws, msg.userId));
    }
  }

  /** コマンドの userId、無ければ接続に紐付いた userId、それも無ければ 'anon'。 */
  private resolveUser(ws: WebSocket, userId: string | undefined): string {
    if (userId && userId.length > 0) return userId;
    return this.connUser.get(ws) ?? 'anon';
  }

  /**
   * 特定 userId の全接続へ playerState を送る (per-connection)。
   * championName は index が world から補完して渡す (不在/未指名なら省略, §1)。
   */
  sendPlayerState(userId: string, state: PlayerStateSnapshot, championName?: string): void {
    // exactOptionalPropertyTypes: championName は値があるときだけキーを足す。
    const msg: ServerMessage = championName === undefined
      ? {
          t: 'playerState',
          karma: state.karma,
          virtue: state.virtue,
          sanctionCost: state.sanctionCost,
          canCheerInMs: state.canCheerInMs,
          championId: state.championId,
          savings: state.savings,
        }
      : {
          t: 'playerState',
          karma: state.karma,
          virtue: state.virtue,
          sanctionCost: state.sanctionCost,
          canCheerInMs: state.canCheerInMs,
          championId: state.championId,
          championName,
          savings: state.savings,
        };
    this.sendToUser(userId, JSON.stringify(msg));
  }

  /** オークションのロット状態 (§v1.3-B ②) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastAuction(lots: AuctionLotView[]): void {
    const msg: Extract<ServerMessage, { t: 'auction' }> = { t: 'auction', lots };
    this.auction = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** 村長 (§v1.3-C ⑥) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastMayor(userId: string | null, endsInMs: number): void {
    const msg: Extract<ServerMessage, { t: 'mayor' }> = { t: 'mayor', userId, endsInMs };
    this.mayor = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** 投票中の法案一覧 (§v1.3-C ⑦) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastLaws(items: LawView[]): void {
    const msg: Extract<ServerMessage, { t: 'laws' }> = { t: 'laws', items };
    this.laws = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** 蜂起状態 (§v1.3-C ⑧) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastRevolt(active: boolean, incite: number, suppress: number, endsInMs: number): void {
    const msg: Extract<ServerMessage, { t: 'revolt' }> = { t: 'revolt', active, incite, suppress, endsInMs };
    this.revolt = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** 戒厳令状態 (§v1.3-C ⑨) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastMartial(mode: MartialMode | null, endsInMs: number): void {
    const msg: Extract<ServerMessage, { t: 'martial' }> = { t: 'martial', mode, endsInMs };
    this.martial = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** 村基金残高 (§v1.3-C ⑩) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastFund(amount: number, threshold: number): void {
    const msg: Extract<ServerMessage, { t: 'fund' }> = { t: 'fund', amount, threshold };
    this.fund = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** 裁判ベットのプール状態を特定 userId の全接続へ送る (§3, yourBet が個別なので per-connection)。 */
  sendBetState(
    userId: string,
    incidentId: string,
    pool: { death: number; educate: number },
    yourBet: { pick: 'death' | 'educate'; amount: number } | null,
  ): void {
    const msg: ServerMessage = { t: 'betState', incidentId, pool, yourBet };
    this.sendToUser(userId, JSON.stringify(msg));
  }

  /** リーダーボード (§4.3) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastLeaderboard(players: LeaderboardEntry[], factions: { guide: number; incite: number }): void {
    const msg: Extract<ServerMessage, { t: 'leaderboard' }> = { t: 'leaderboard', players, factions };
    this.leaderboard = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** 特定 userId の全接続へ commandRejected を送る。 */
  sendRejected(userId: string, reason: string): void {
    const msg: ServerMessage = { t: 'commandRejected', reason };
    this.sendToUser(userId, JSON.stringify(msg));
  }

  /** 状態パネル (§7) を更新し、全クライアントへ配る。接続時にも現値を送る。 */
  broadcastSysStatus(s: Omit<SysStatusMessage, 't'>): void {
    const msg: SysStatusMessage = { t: 'sysStatus', ...s };
    this.sysStatus = msg;
    this.fanout(JSON.stringify(msg));
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
