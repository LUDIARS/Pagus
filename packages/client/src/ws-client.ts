// WS 接続。server からの snapshot/log を受け、扇動/沈静化コマンドを送る。自動再接続。

import type { WireWorld, ServerMessage, ClientMessage, Phase, TrialLine, LlmInfo, ChronicleEntry, PlayerActionEntry } from '@pagus/sim';

export interface WsHandlers {
  onSnapshot(world: WireWorld): void;
  onLog(phase: Phase, text: string): void;
  onStatus(status: string): void;
  onPlayers(count: number): void;
  onTrialLines(incidentId: string, lines: TrialLine[]): void;
  onLlm(info: LlmInfo): void;
  onChronicle(entries: ChronicleEntry[]): void;
  /** その接続ユーザのカルマ/善性状態 (§4.4)。Phase D で本 UI。 */
  onPlayerState?(state: { karma: number; virtue: number; sanctionCost: number; canCheerInMs: number }): void;
  /** コマンド却下 (カルマ不足/インターバル中など)。 */
  onCommandRejected?(reason: string): void;
  /** 人間の行動記録 (§8)。 */
  onPlayerActions?(entries: PlayerActionEntry[]): void;
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
      else if (msg.t === 'trialLines') h.onTrialLines(msg.incidentId, msg.lines);
      else if (msg.t === 'llm') h.onLlm(msg.info);
      else if (msg.t === 'chronicle') h.onChronicle(msg.entries);
      else if (msg.t === 'playerState') {
        h.onPlayerState?.({ karma: msg.karma, virtue: msg.virtue, sanctionCost: msg.sanctionCost, canCheerInMs: msg.canCheerInMs });
      } else if (msg.t === 'commandRejected') h.onCommandRejected?.(msg.reason);
      else if (msg.t === 'playerActions') h.onPlayerActions?.(msg.entries);
    };
  };
  open();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
  };
}
