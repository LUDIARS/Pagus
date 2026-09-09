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
  type TrialVoice,
  type LlmInfo,
  type ChronicleEntry,
  type PlayerActionEntry,
  type LeaderboardEntry,
  type Faction,
  type CardName,
  type MarketItem,
  type ThemeLexicon,
  type MoralDial,
  type AuctionLotView,
  type LawView,
  type MartialMode,
  type HighlightCard,
  type SeasonWinner,
  type VillagerGachaKind,
  type ChatMessage,
  type ChatChannel,
} from '@pagus/sim';
import type { PlayerStateSnapshot } from './player-state.js';
import { isValidUserCode, connectionsToLogout } from './user-code.js';
import { isTownArea, type TownArea, type WireWorld } from '@pagus/sim';
import { areaFrame } from './area-stream.js';

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
  onHello(userId: string, userName?: string): void;
  // 課金モック / 別端末ログイン (§v1.3-F)。
  onTopup(amount: number, userId: string): void;
  onLogin(userId: string): void;
  onSetUserName(name: string, userId: string): void;
  onChat(text: string, userId: string, channel: ChatChannel, dmWithVillagerId: string | undefined): void;
  onIncite(targetId: string, rumorAboutId: string | undefined, userId: string): void;
  onSanction(targetId: string, userId: string): void;
  onCheer(targetId: string, userId: string): void;
  // 即効介入 (§v1.4-A): 野次 / 証言 / 差し入れ・毒饅頭。
  onHeckle(side: 'agitate' | 'soothe', userId: string): void;
  onTestify(stance: 'accuse' | 'defend', text: string | undefined, userId: string): void;
  onGift(targetId: string, kind: 'treat' | 'poison', userId: string): void;
  onSpot(place: string, mode: 'defile' | 'bless', userId: string): void;
  onFanFlames(targetId: string, userId: string): void;
  onVote(pick: string, userId: string): void;
  onChampion(targetId: string, userId: string): void;
  onVillagerGacha(kind: VillagerGachaKind, userId: string): void;
  /** フィールドアイテム配置 (§16)。toChampion=true で推しに直接送る。 */
  onPlaceItem(kind: 'random' | 'precious' | 'drug', toChampion: boolean, userId: string): void;
  onAddRule(text: string, userId: string): void;
  onRemoveRule(ruleId: string, userId: string): void;
  onFaction(side: Faction, userId: string): void;
  onCard(card: CardName, args: CardArgs, userId: string): void;
  onEventCard(userId: string): void;
  onInsure(targetId: string, premium: number, userId: string): void;
  onBuyMarket(item: MarketItem, args: MarketArgs, userId: string): void;
  onBid(lotId: string, amount: number, userId: string): void;
  // 政治パック (§v1.3-C) + 村長リコール (§17)。
  onRecallMayor(userId: string): void;
  onProposeLaw(text: string, userId: string): void;
  onVoteLaw(lawId: string, approve: boolean, userId: string): void;
  onRevolt(side: 'incite' | 'suppress', userId: string): void;
  onMartial(mode: MartialMode, userId: string): void;
  // 演出・協力パック (§v1.3-D)。
  onPredictDay(dayOfMonth: number, userId: string): void;
  onVoteMvp(villagerId: string, userId: string): void;
  onPray(userId: string): void;
  onRaidStrike(amount: number, userId: string): void;
}

export class GameWsServer {
  private readonly wss: WebSocketServer;
  private lastSnapshot: string | null = null;
  private areaWorld: WireWorld | null = null;
  private areaSequence = 0;
  private readonly areas = new Map<WebSocket, TownArea>();
  private readonly areaCache = new Map<string, string>();
  private readonly areaRadii = new Map<WebSocket, 1 | 2>();
  private llmInfo: LlmInfo | null = null;
  /** テーマパック (§v1.4-D)。接続時に現値を送る。 */
  private theme: Extract<ServerMessage, { t: 'theme' }> | null = null;
  private chronicle: ChronicleEntry[] = [];
  private playerActions: PlayerActionEntry[] = [];
  /** リーダーボード (§4.3) の最新値。接続時に現値を送る。 */
  private leaderboard: Extract<ServerMessage, { t: 'leaderboard' }> | null = null;
  /** ユーザー間チャットの最新履歴。接続時に現値を送る。 */
  private chat: Extract<ServerMessage, { t: 'chat' }> | null = null;
  /** 状態パネル (§7) の最新値。接続時に現値を送る。 */
  private sysStatus: SysStatusMessage | null = null;
  /** オークション (§v1.3-B ②) の最新ロット状態。接続時に現値を送る。 */
  private auction: Extract<ServerMessage, { t: 'auction' }> | null = null;
  /** 政治パック (§v1.3-C) の最新状態 (法案/革命/戒厳令/基金)。接続時に現値を送る。村長 (§17) は snapshot。 */
  private laws: Extract<ServerMessage, { t: 'laws' }> | null = null;
  private revolt: Extract<ServerMessage, { t: 'revolt' }> | null = null;
  private martial: Extract<ServerMessage, { t: 'martial' }> | null = null;
  private fund: Extract<ServerMessage, { t: 'fund' }> | null = null;
  /** 演出・協力パック (§v1.3-D) の最新状態 (ハイライト/レイド/MVP/シーズン)。接続時に現値を送る。 */
  private highlights: Extract<ServerMessage, { t: 'highlights' }> | null = null;
  private raid: Extract<ServerMessage, { t: 'raid' }> | null = null;
  private mvp: Extract<ServerMessage, { t: 'mvp' }> | null = null;
  private season: Extract<ServerMessage, { t: 'season' }> | null = null;
  /** 裁判の声。接続時に現値を送る。 */
  private trialVoices: Extract<ServerMessage, { t: 'trialVoices' }> | null = null;
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

  /** テーマパック (§v1.4-D) を設定し、全クライアントへ配る。接続時にも現値を送る。 */
  setTheme(pack: string, moral: MoralDial, lexicon: ThemeLexicon): void {
    const msg: Extract<ServerMessage, { t: 'theme' }> = { t: 'theme', pack, moral, lexicon };
    this.theme = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** 村の歴史を更新し、全クライアントへ配る。 */
  updateChronicle(entries: ChronicleEntry[]): void {
    this.chronicle = entries;
    this.fanout(JSON.stringify({ t: 'chronicle', entries } satisfies ServerMessage));
  }

  connectedUserIds(): string[] {
    return [...new Set(this.connUser.values())].sort((a, b) => a.localeCompare(b));
  }

  broadcastEventTitle(title: string, kind: 'mystery' | 'trial' | 'life', subtitle?: string): void {
    const msg: Extract<ServerMessage, { t: 'eventTitle' }> =
      subtitle === undefined ? { t: 'eventTitle', title, kind, at: Date.now() } : { t: 'eventTitle', title, subtitle, kind, at: Date.now() };
    this.fanout(JSON.stringify(msg));
  }

  private onConnection(ws: WebSocket): void {
    // 接続直後に最新スナップショット・接続人数・LLM 構成・村の歴史・人間の行動記録を送る。
    if (this.lastSnapshot) ws.send(this.lastSnapshot);
    this.areas.set(ws, 'plaza');
    this.sendArea(ws);
    if (this.llmInfo) ws.send(JSON.stringify({ t: 'llm', info: this.llmInfo } satisfies ServerMessage));
    if (this.theme) ws.send(JSON.stringify(this.theme));
    if (this.chronicle.length > 0) {
      ws.send(JSON.stringify({ t: 'chronicle', entries: this.chronicle } satisfies ServerMessage));
    }
    ws.send(JSON.stringify({ t: 'playerActions', entries: this.playerActions } satisfies ServerMessage));
    if (this.sysStatus) ws.send(JSON.stringify(this.sysStatus));
    if (this.leaderboard) ws.send(JSON.stringify(this.leaderboard));
    if (this.chat) ws.send(JSON.stringify(this.chat));
    if (this.auction) ws.send(JSON.stringify(this.auction));
    if (this.laws) ws.send(JSON.stringify(this.laws));
    if (this.revolt) ws.send(JSON.stringify(this.revolt));
    if (this.martial) ws.send(JSON.stringify(this.martial));
    if (this.fund) ws.send(JSON.stringify(this.fund));
    if (this.highlights) ws.send(JSON.stringify(this.highlights));
    if (this.raid) ws.send(JSON.stringify(this.raid));
    if (this.mvp) ws.send(JSON.stringify(this.mvp));
    if (this.season) ws.send(JSON.stringify(this.season));
    if (this.trialVoices) ws.send(JSON.stringify(this.trialVoices));
    this.broadcastPlayers();
    ws.on('close', () => {
      this.connUser.delete(ws);
      this.areas.delete(ws);
      this.areaRadii.delete(ws);
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

  /**
   * 別端末ログイン (§v1.3-F)。code(=userId UUIDv4) で現接続を束ね直す。
   * 同じ userId にバインドされた他接続は loggedOut を送って close する (古いセッションを追い出す)。
   * 空/不正形式の code は reject (無言フォールバック禁止)。
   */
  private loginConn(ws: WebSocket, code: string): void {
    if (!isValidUserCode(code)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'commandRejected', reason: 'ユーザーコードが不正な形式' } satisfies ServerMessage));
      }
      return;
    }
    // 同じ userId の他接続を追い出す。
    for (const other of connectionsToLogout(this.connUser, ws, code)) {
      if (other.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ t: 'loggedOut', reason: '別の端末でログインされました' } satisfies ServerMessage));
        other.close();
      }
      this.connUser.delete(other);
    }
    this.connUser.set(ws, code);
    this.h.onLogin(code); // 最新 playerState 等を新接続へ送る (index 側)
  }

  private handle(ws: WebSocket, msg: ClientMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'subscribeArea') {
      if (isTownArea(msg.area) && (msg.radius === undefined || msg.radius === 1 || msg.radius === 2)) {
        this.areas.set(ws, msg.area);
        this.areaRadii.set(ws, msg.radius ?? 1);
        this.sendArea(ws);
      }
      return;
    }
    if (msg.t === 'hello') {
      this.bind(ws, msg.userId);
      this.h.onHello(msg.userId, msg.userName);
    } else if (msg.t === 'topup') {
      this.bind(ws, msg.userId);
      this.h.onTopup(msg.amount, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'login') {
      this.loginConn(ws, msg.code);
    } else if (msg.t === 'setUserName') {
      this.bind(ws, msg.userId);
      this.h.onSetUserName(msg.name, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'chat') {
      this.bind(ws, msg.userId);
      this.h.onChat(msg.text, this.resolveUser(ws, msg.userId), msg.channel ?? 'human', msg.dmWithVillagerId);
    } else if (msg.t === 'incite') {
      this.bind(ws, msg.userId);
      this.h.onIncite(msg.targetId, msg.rumorAboutId, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'sanction') {
      this.bind(ws, msg.userId);
      this.h.onSanction(msg.targetId, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'cheer') {
      this.bind(ws, msg.userId);
      this.h.onCheer(msg.targetId, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'heckle') {
      this.bind(ws, msg.userId);
      this.h.onHeckle(msg.side, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'testify') {
      this.bind(ws, msg.userId);
      this.h.onTestify(msg.stance, msg.text, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'gift') {
      this.bind(ws, msg.userId);
      this.h.onGift(msg.targetId, msg.kind, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'spot') {
      this.bind(ws, msg.userId);
      this.h.onSpot(msg.place, msg.mode, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'fanFlames') {
      this.bind(ws, msg.userId);
      this.h.onFanFlames(msg.targetId, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'vote') {
      this.bind(ws, msg.userId);
      this.h.onVote(msg.pick, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'champion') {
      this.bind(ws, msg.userId);
      this.h.onChampion(msg.targetId, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'villagerGacha') {
      this.bind(ws, msg.userId);
      this.h.onVillagerGacha(msg.kind, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'placeItem') {
      this.bind(ws, msg.userId);
      this.h.onPlaceItem(msg.kind, msg.toChampion ?? false, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'addRule') {
      this.bind(ws, msg.userId);
      this.h.onAddRule(msg.text, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'removeRule') {
      this.bind(ws, msg.userId);
      this.h.onRemoveRule(msg.ruleId, this.resolveUser(ws, msg.userId));
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
    } else if (msg.t === 'eventCard') {
      this.bind(ws, msg.userId);
      this.h.onEventCard(this.resolveUser(ws, msg.userId));
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
    } else if (msg.t === 'recallMayor') {
      this.bind(ws, msg.userId);
      this.h.onRecallMayor(this.resolveUser(ws, msg.userId));
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
    } else if (msg.t === 'predictDay') {
      this.bind(ws, msg.userId);
      this.h.onPredictDay(msg.dayOfMonth, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'voteMvp') {
      this.bind(ws, msg.userId);
      this.h.onVoteMvp(msg.villagerId, this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'pray') {
      this.bind(ws, msg.userId);
      this.h.onPray(this.resolveUser(ws, msg.userId));
    } else if (msg.t === 'raidStrike') {
      this.bind(ws, msg.userId);
      this.h.onRaidStrike(msg.amount, this.resolveUser(ws, msg.userId));
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
    const msg: ServerMessage = {
      t: 'playerState',
      karma: state.karma,
      virtue: state.virtue,
      userName: state.userName,
      sanctionCost: state.sanctionCost,
      inciteCost: state.inciteCost,
      canCheerInMs: state.canCheerInMs,
      canIntervene: state.canIntervene,
      heckleCost: state.heckleCost,
      canHeckleInMs: state.canHeckleInMs,
      testifyCost: state.testifyCost,
      giftTreatCost: state.giftTreatCost,
      giftPoisonCost: state.giftPoisonCost,
      spotCost: state.spotCost,
      fanFlamesCost: state.fanFlamesCost,
      championId: state.championId,
      spent: state.spent,
      eventCards: state.eventCards,
      ...(championName !== undefined ? { championName } : {}),
    };
    this.sendToUser(userId, JSON.stringify(msg));
  }

  /** オークションのロット状態 (§v1.3-B ②) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastAuction(lots: AuctionLotView[]): void {
    const msg: Extract<ServerMessage, { t: 'auction' }> = { t: 'auction', lots };
    this.auction = msg;
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

  /** ハイライト一覧 (§v1.3-D ㉑) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastHighlights(cards: HighlightCard[]): void {
    const msg: Extract<ServerMessage, { t: 'highlights' }> = { t: 'highlights', cards };
    this.highlights = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** 共闘レイド状態 (§v1.3-D ㉙) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastRaid(active: boolean, villainName: string, hp: number, hpMax: number, endsInMs: number): void {
    const msg: Extract<ServerMessage, { t: 'raid' }> = { t: 'raid', active, villainName, hp, hpMax, endsInMs };
    this.raid = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** 月間MVP (§v1.3-D ㉔) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastMvp(villagerId: string, name: string): void {
    const msg: Extract<ServerMessage, { t: 'mvp' }> = { t: 'mvp', villagerId, name };
    this.mvp = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** シーズン確定 (§v1.3-D ㉚) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastSeason(number: number, winner: SeasonWinner, leaderboard: LeaderboardEntry[]): void {
    const msg: Extract<ServerMessage, { t: 'season' }> = { t: 'season', number, winner, leaderboard };
    this.season = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** リーダーボード (§4.3) を更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastLeaderboard(players: LeaderboardEntry[], factions: { guide: number; incite: number }): void {
    const msg: Extract<ServerMessage, { t: 'leaderboard' }> = { t: 'leaderboard', players, factions };
    this.leaderboard = msg;
    this.fanout(JSON.stringify(msg));
  }

  /** ユーザー間チャットを更新し全クライアントへ配る。接続時にも現値を送る。 */
  broadcastChat(messages: ChatMessage[]): void {
    const msg: Extract<ServerMessage, { t: 'chat' }> = { t: 'chat', messages };
    this.chat = msg;
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
    this.areaWorld = structuredClone(toWire(world));
    // Global panels still receive the roster; only area frames carry movement routes.
    const roster = this.areaWorld.villagers.map((v) => {
      if (!v.behaviorTrace) return v;
      const { route: _route, ...trace } = v.behaviorTrace;
      return { ...v, behaviorTrace: trace };
    });
    const msg: ServerMessage = { t: 'snapshot', world: { ...this.areaWorld, villagers: roster } };
    this.lastSnapshot = JSON.stringify(msg);
    for (const c of this.wss.clients) {
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount <= 1024 * 1024) c.send(this.lastSnapshot);
    }
    this.areaSequence++;
    this.areaCache.clear();
    for (const c of this.wss.clients) this.sendArea(c);
  }

  private sendArea(ws: WebSocket): void {
    if (!this.areaWorld || ws.readyState !== WebSocket.OPEN) return;
    // A slow viewer resynchronizes on the next complete frame; simulation never waits.
    if (ws.bufferedAmount > 1024 * 1024) return;
    const area = this.areas.get(ws) ?? 'plaza';
    const radius = this.areaRadii.get(ws) ?? 1;
    const cacheKey = `${area}:${radius}`;
    let frame = this.areaCache.get(cacheKey);
    if (!frame) {
      frame = JSON.stringify(areaFrame(this.areaWorld, area, this.areaSequence, radius));
      this.areaCache.set(cacheKey, frame);
    }
    ws.send(frame);
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

  /** 他ユーザーの裁判の声と、信仰している住民の応答を配る。 */
  broadcastTrialVoices(incidentId: string, voices: TrialVoice[]): void {
    const msg: Extract<ServerMessage, { t: 'trialVoices' }> = { t: 'trialVoices', incidentId, voices };
    this.trialVoices = msg;
    this.fanout(JSON.stringify(msg));
  }

  private fanout(serialized: string): void {
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(serialized);
    }
  }
}
