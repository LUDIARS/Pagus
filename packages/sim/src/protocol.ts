// WS 配線契約。World は Map を持ち JSON 化できないので、villagers を配列にした
// WireWorld を介して server→client へ送る。client もこの型だけ見れば描画できる。

import type { World, WorldConfig, Villager, Calendar, Phase, Incident, TrialState, ScheduledIncident, VillageRule } from './types/index.js';
import type { VirtueVector } from './virtue.js';
import { defaultBehaviorRules, type BehaviorRule } from './behavior-rules.js';

export interface WireWorld {
  config: WorldConfig;
  term: number;
  calendar: Calendar;
  phase: Phase;
  reputation: VirtueVector;
  villagers: Villager[];
  incident: Incident | null;
  trial: TrialState | null;
  scheduledIncident: ScheduledIncident | null;
  villageRules: VillageRule[];
  behaviorRules: BehaviorRule[];
}

export function toWire(world: World): WireWorld {
  return {
    config: world.config,
    term: world.term,
    calendar: world.calendar,
    phase: world.phase,
    reputation: world.reputation,
    villagers: [...world.villagers.values()],
    incident: world.incident,
    trial: world.trial,
    scheduledIncident: world.scheduledIncident,
    villageRules: world.villageRules,
    behaviorRules: world.behaviorRules,
  };
}

/** toWire の逆。配列で持つ villagers を Map に戻して World を再構築する (スナップショット復元)。 */
export function fromWire(wire: WireWorld): World {
  return {
    config: wire.config,
    term: wire.term,
    calendar: wire.calendar,
    phase: wire.phase,
    reputation: wire.reputation,
    villagers: new Map(wire.villagers.map((v) => [v.id, v])),
    incident: wire.incident,
    trial: wire.trial,
    scheduledIncident: wire.scheduledIncident ?? null,
    villageRules: wire.villageRules ?? [],
    behaviorRules: wire.behaviorRules ?? defaultBehaviorRules(),
  };
}

/** 現スナップショット形式のバージョン。型が壊れる変更時に増やし、古い snapshot を破棄する。 */
export const WORLD_SNAPSHOT_VERSION = 4;

/**
 * 永続化する world スナップショット。WireWorld (JSON 化可能な world) に加え、
 * 再起動後も出生 id (born_N) / 事件用キャラ id (incident_N) が衝突しないよう
 * TermMachine の通し番号を保持する。
 */
export interface WorldSnapshot {
  version: number;
  /** 保存時刻 (ISO 文字列, デバッグ用)。 */
  savedAt: string;
  world: WireWorld;
  /** TermMachine.bornCount (出生どうぶつの通し番号)。 */
  bornCount: number;
  /** TermMachine.incidentCount (事件用キャラの通し番号, §12.3.3)。 */
  incidentCount: number;
  /** TermMachine.ruleCount (ふるまいの法則の通し番号, §2.1)。 */
  ruleCount: number;
}

/** 裁判の糾弾セリフ (server が生成/再利用して配る)。 */
export interface TrialLine {
  speaker: string; // 糾弾する村人 id
  text: string;
}

/** 村の歴史エントリの種別 (§8 タブ分類)。絵文字接頭辞でなく生成元が明示する。 */
export type ChronicleKind =
  | 'incident'
  | 'trial'
  | 'verdict'
  | 'reform'
  | 'marriage'
  | 'birth'
  | 'reconcile'
  | 'holiday'
  | 'day'
  | 'month'
  | 'rule'
  | 'sanction'
  | 'other';

/** 村の歴史の 1 エントリ (節目の出来事)。 */
export interface ChronicleEntry {
  /** ゲーム内日付 (例 "6月12日")。 */
  date: string;
  text: string;
  /** 種別 (§8 タブ分類)。旧データは未設定 = 'other' 相当に扱う。 */
  kind?: ChronicleKind;
}

/** 人間の行動記録の 1 エントリ (§8 村の歴史「人間の行動記録」)。 */
export interface PlayerActionEntry {
  /** ゲーム内日付 (例 "6月12日")。 */
  date: string;
  userId: string;
  type: 'incite' | 'sanction' | 'cheer';
  /** 操作対象のどうぶつ名。 */
  target: string;
}

/** 接続ユーザのカルマ/善性状態 (per-connection 配信)。 */
export interface PlayerState {
  /** 現在のカルマ (操作の通貨)。 */
  karma: number;
  /** プレイヤー善性 (応援で上がり、制裁コストを重くする)。 */
  virtue: number;
  /** いま制裁に必要なカルマ (善性込みの実コスト)。 */
  sanctionCost: number;
  /** 次に応援できるまでの残りミリ秒 (0 = いま可能)。 */
  canCheerInMs: number;
}

/** LLM コストログの 1 件 (§7, 直近分を配信)。 */
export interface CostEntry {
  /** 用途 (parts.kind: 'emotion' | 'action' | 'incident' | 'world' など)。 */
  kind: string;
  /** モデル id 文字列 (単価判定の元)。 */
  model: string;
  inTokens: number;
  outTokens: number;
  /** 概算コスト (USD)。 */
  costUsd: number;
  /** 記録時刻 (epoch ms)。 */
  at: number;
}

/** 用途 (kind) ごとのコスト集計 (§7)。 */
export interface CostKindSummary {
  calls: number;
  usd: number;
  inTokens: number;
  outTokens: number;
}

/** LLM コストログの集計 (§7, sysStatus で配信)。 */
export interface CostSummary {
  /** 累計概算コスト (USD)。 */
  totalUsd: number;
  /** 総 LLM 呼び出し回数。 */
  calls: number;
  /** kind ごとの集計。 */
  byKind: Record<string, CostKindSummary>;
  /** 直近の呼び出し (新しい順, 最大 30 件)。 */
  recent: CostEntry[];
}

/** 稼働中の LLM 構成 (UI 表示用)。 */
export interface LlmInfo {
  mode: 'stub' | 'llm';
  /** どうぶつ駆動に使うバックエンド一覧。 */
  backends: { id: string; provider: string; model: string }[];
  /** 重い局面 (裁判/教育) で寄せる strong tier の id 一覧。 */
  strong: string[];
  /** villager id → backend id の (準固定) 割当。 */
  assignments: Record<string, string>;
}

/** server → client。 */
export type ServerMessage =
  | { t: 'snapshot'; world: WireWorld }
  | { t: 'log'; phase: Phase; text: string }
  | { t: 'players'; count: number } // 同時接続プレイヤー数
  | { t: 'trialLines'; incidentId: string; lines: TrialLine[] } // 裁判の糾弾セリフ
  | { t: 'llm'; info: LlmInfo } // 稼働中の LLM 構成
  | { t: 'chronicle'; entries: ChronicleEntry[] } // 村の歴史
  | {
      t: 'playerState'; // その接続ユーザの状態
      karma: number;
      virtue: number;
      sanctionCost: number;
      canCheerInMs: number;
      /** 推し (champion) の villager id。未指名は null (§1)。 */
      championId?: string | null;
      /** 推しの名前 (index が world から補完)。未指名/不在なら省略。 */
      championName?: string;
    }
  | { t: 'commandRejected'; reason: string } // カルマ不足/インターバル中など
  | { t: 'playerActions'; entries: PlayerActionEntry[] } // 人間の行動記録 (§8, broadcast)
  | {
      t: 'sysStatus'; // 状態パネル (§7): 稼働時間・ゲーム内日付・LLM コスト
      /** server 起動時刻 (epoch ms)。稼働時間 = now - startedAt。 */
      startedAt: number;
      /** ゲーム内の年 (calendar.year)。 */
      gameYear: number;
      /** ゲーム内の日付 (例 "6月12日")。 */
      gameDate: string;
      /** 経過ターム (= 総日数)。 */
      term: number;
      /** LLM コストログ集計。 */
      cost: CostSummary;
    };

/** client → server。 */
export type ClientMessage =
  | { t: 'hello'; userId: string } // 接続とユーザを紐付け (per-user カルマ push 用)
  | { t: 'incite'; targetId: string; rumorAboutId?: string; userId?: string } // 対象に偽情報を吹き込み事件化を促す (§4.2)
  | { t: 'sanction'; targetId: string; userId?: string } // 対象を即時つるし上げ裁判にかける (§4.3)
  | { t: 'cheer'; targetId: string; userId?: string } // 対象の気質を後押しする (§4.5)
  | { t: 'vote'; pick: string; userId?: string } // 裁判への 1 票 (foolish=候補id / fate='kill'|'spare')。userId で接続ユーザを区別 (重み合算)
  | { t: 'champion'; targetId: string; userId?: string } // 推しを 1 体指名 (§1)。再送で差し替え
  | { t: 'addRule'; text: string; userId?: string } // カルマを払って村のしきたりを 1 件追加 (§2)
  | { t: 'removeRule'; ruleId: string; userId?: string }; // カルマを払って村のしきたりを 1 件廃する (§2)
