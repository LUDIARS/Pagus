// WS 接続。server からの snapshot/log を受け、扇動/沈静化コマンドを送る。自動再接続。

import type { WireWorld, ServerMessage, ClientMessage, Phase, TrialLine, TrialVoice, LlmInfo, ChronicleEntry, PlayerActionEntry, CostSummary, LeaderboardEntry, AuctionLotView, LawView, MartialMode, HighlightCard, SeasonWinner, ChatMessage } from '@pagus/sim';

/** 裁判ベットのプール状態 (§3 betState 受信ペイロード)。 */
export interface BetStateView {
  incidentId: string;
  pool: { death: number; educate: number };
  yourBet: { pick: 'death' | 'educate'; amount: number } | null;
}

/** リーダーボード (§4.3 leaderboard 受信ペイロード)。 */
export interface LeaderboardView {
  players: LeaderboardEntry[];
  factions: { guide: number; incite: number };
}

/** 状態パネル (§7) の受信ペイロード。 */
export interface SysStatus {
  startedAt: number;
  gameYear: number;
  gameDate: string;
  term: number;
  cost: CostSummary;
}

export interface WsHandlers {
  onSnapshot(world: WireWorld): void;
  onLog(phase: Phase, text: string): void;
  onStatus(status: string): void;
  onPlayers(count: number): void;
  onTrialLines(incidentId: string, lines: TrialLine[]): void;
  onTrialVoices?(incidentId: string, voices: TrialVoice[]): void;
  onLlm(info: LlmInfo): void;
  onChronicle(entries: ChronicleEntry[]): void;
  /** その接続ユーザのカルマ/善性状態 (§4.4)。推し (§1)・預金 (§v1.3-B ④)・課金額 (§v1.3-F) を含む。 */
  onPlayerState?(state: { karma: number; virtue: number; userName: string | null; sanctionCost: number; inciteCost: number; canCheerInMs: number; championId: string | null; championName?: string; spent: number; eventCards: number }): void;
  /** 別端末ログインで現セッションが追い出された (§v1.3-F)。 */
  onLoggedOut?(reason: string): void;
  /** コマンド却下 (カルマ不足/インターバル中など)。 */
  onCommandRejected?(reason: string): void;
  /** 人間の行動記録 (§8)。 */
  onPlayerActions?(entries: PlayerActionEntry[]): void;
  /** 状態パネル (§7): 稼働時間・ゲーム内日付・LLM コスト。 */
  onSysStatus?(s: SysStatus): void;
  /** 裁判ベットのプール状態 (§3)。 */
  onBetState?(s: BetStateView): void;
  /** 称号・陣営のリーダーボード (§4.3)。 */
  onLeaderboard?(s: LeaderboardView): void;
  /** オークションのロット状態 (§v1.3-B ②)。 */
  onAuction?(lots: AuctionLotView[]): void;
  /** 投票中の法案一覧 (§v1.3-C ⑦)。 */
  onLaws?(items: LawView[]): void;
  /** 蜂起状態 (§v1.3-C ⑧)。 */
  onRevolt?(active: boolean, incite: number, suppress: number, endsInMs: number): void;
  /** 戒厳令状態 (§v1.3-C ⑨)。 */
  onMartial?(mode: MartialMode | null, endsInMs: number): void;
  /** 村基金残高 (§v1.3-C ⑩)。 */
  onFund?(amount: number, threshold: number): void;
  /** ハイライト一覧 (§v1.3-D ㉑)。 */
  onHighlights?(cards: HighlightCard[]): void;
  /** 月間MVP (§v1.3-D ㉔)。 */
  onMvp?(villagerId: string, name: string): void;
  /** ユーザー間チャット。 */
  onChat?(messages: ChatMessage[]): void;
  /** 共闘レイド状態 (§v1.3-D ㉙)。 */
  onRaid?(active: boolean, villainName: string, hp: number, hpMax: number, endsInMs: number): void;
  /** シーズン確定 (§v1.3-D ㉚)。 */
  onSeason?(num: number, winner: SeasonWinner, leaderboard: LeaderboardEntry[]): void;
}

export interface Conn {
  send(msg: ClientMessage): void;
  /** 再接続せず接続を畳む (§v1.3-F 別端末ログインで追い出された時など)。 */
  close(): void;
}

export function connect(url: string, h: WsHandlers): Conn {
  let ws: WebSocket | null = null;
  let stopped = false; // true なら再接続しない (close() で立てる)
  const pending: ClientMessage[] = [];

  const flush = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const msg of pending.splice(0)) ws.send(JSON.stringify(msg));
  };

  const open = (): void => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      h.onStatus('● 接続');
      flush();
    };
    ws.onerror = () => h.onStatus('● エラー');
    ws.onclose = () => {
      if (stopped) return; // 意図的な close は再接続しない
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
      else if (msg.t === 'trialLines') h.onTrialLines(msg.incidentId, msg.lines);
      else if (msg.t === 'trialVoices') h.onTrialVoices?.(msg.incidentId, msg.voices);
      else if (msg.t === 'llm') h.onLlm(msg.info);
      else if (msg.t === 'chronicle') h.onChronicle(msg.entries);
      else if (msg.t === 'playerState') {
        h.onPlayerState?.({
          karma: msg.karma,
          virtue: msg.virtue,
          userName: msg.userName,
          sanctionCost: msg.sanctionCost,
          inciteCost: msg.inciteCost,
          canCheerInMs: msg.canCheerInMs,
          championId: msg.championId ?? null,
          ...(msg.championName !== undefined ? { championName: msg.championName } : {}),
          spent: msg.spent,
          eventCards: msg.eventCards,
        });
      } else if (msg.t === 'loggedOut') h.onLoggedOut?.(msg.reason);
      else if (msg.t === 'auction') h.onAuction?.(msg.lots);
      else if (msg.t === 'commandRejected') h.onCommandRejected?.(msg.reason);
      else if (msg.t === 'playerActions') h.onPlayerActions?.(msg.entries);
      else if (msg.t === 'sysStatus') {
        h.onSysStatus?.({
          startedAt: msg.startedAt,
          gameYear: msg.gameYear,
          gameDate: msg.gameDate,
          term: msg.term,
          cost: msg.cost,
        });
      } else if (msg.t === 'betState') {
        h.onBetState?.({ incidentId: msg.incidentId, pool: msg.pool, yourBet: msg.yourBet });
      } else if (msg.t === 'leaderboard') {
        h.onLeaderboard?.({ players: msg.players, factions: msg.factions });
      } else if (msg.t === 'laws') h.onLaws?.(msg.items);
      else if (msg.t === 'revolt') h.onRevolt?.(msg.active, msg.incite, msg.suppress, msg.endsInMs);
      else if (msg.t === 'martial') h.onMartial?.(msg.mode, msg.endsInMs);
      else if (msg.t === 'fund') h.onFund?.(msg.amount, msg.threshold);
      else if (msg.t === 'highlights') h.onHighlights?.(msg.cards);
      else if (msg.t === 'chat') h.onChat?.(msg.messages);
      else if (msg.t === 'mvp') h.onMvp?.(msg.villagerId, msg.name);
      else if (msg.t === 'raid') h.onRaid?.(msg.active, msg.villainName, msg.hp, msg.hpMax, msg.endsInMs);
      else if (msg.t === 'season') h.onSeason?.(msg.number, msg.winner, msg.leaderboard);
    };
  };
  open();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return;
      }
      pending.push(msg);
      if (pending.length > 20) pending.shift();
      h.onStatus('○ 接続待ち (送信予約)');
    },
    close() {
      stopped = true;
      pending.length = 0;
      ws?.close();
    },
  };
}
