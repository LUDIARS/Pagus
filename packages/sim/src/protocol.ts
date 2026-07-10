// WS 配線契約。World は Map を持ち JSON 化できないので、villagers を配列にした
// WireWorld を介して server→client へ送る。client もこの型だけ見れば描画できる。

import type { World, WorldConfig, Villager, Calendar, Phase, Incident, TrialState, ScheduledIncident, ScheduledParty, VillageRule, MartialState, MartialMode, FieldItem, MayorPoll, PlaceStateEntry, PlotThread, MoralDial, ResidentHistoryEntry, VillagerRelationship, UserFaithEntry, VillagerActionEntry, VillagerGachaKind } from './types/index.js';
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
  trialDayKey?: string | null;
  scheduledIncident: ScheduledIncident | null;
  scheduledParty: ScheduledParty | null;
  villageRules: VillageRule[];
  behaviorRules: BehaviorRule[];
  /** フィールドに落ちているアイテム (§16)。 */
  items: FieldItem[];
  /** 場所の状態 (§v1.4-A' spot)。 */
  placeStates: PlaceStateEntry[];
  /** 火種 (§v1.4-B)。 */
  plotThreads: PlotThread[];
  /** 現村長の villager id (§17)。空位は null。 */
  mayorId: string | null;
  /** 次の村長選挙までの残りターム数 (§17)。 */
  mayorTermsLeft: number;
  /** 選挙運動期間中の匿名世論調査 (§17)。期間外は null。 */
  mayorPoll: MayorPoll | null;
  /** 戒厳令 (§v1.3-C ⑨)。発動中のみ。 */
  martial?: MartialState;
  residentHistory: ResidentHistoryEntry[];
  relationships: VillagerRelationship[];
  userFaith: UserFaithEntry[];
  villagerActionLog: VillagerActionEntry[];
}

export function toWire(world: World): WireWorld {
  const wire: WireWorld = {
    config: world.config,
    term: world.term,
    calendar: world.calendar,
    phase: world.phase,
    reputation: world.reputation,
    villagers: [...world.villagers.values()],
    incident: world.incident,
    trial: world.trial,
    trialDayKey: world.trialDayKey,
    scheduledIncident: world.scheduledIncident,
    scheduledParty: world.scheduledParty,
    villageRules: world.villageRules,
    behaviorRules: world.behaviorRules,
    items: world.items,
    placeStates: world.placeStates,
    plotThreads: world.plotThreads,
    mayorId: world.mayorId,
    mayorTermsLeft: world.mayorTermsLeft,
    mayorPoll: world.mayorPoll,
    residentHistory: world.residentHistory,
    relationships: world.relationships,
    userFaith: world.userFaith,
    villagerActionLog: world.villagerActionLog,
  };
  // exactOptionalPropertyTypes: 戒厳令は発動中のみキーを足す (§v1.3-C ⑨)。
  if (world.martial !== undefined) wire.martial = world.martial;
  return wire;
}

/** toWire の逆。配列で持つ villagers を Map に戻して World を再構築する (スナップショット復元)。 */
export function fromWire(wire: WireWorld): World {
  const world: World = {
    config: wire.config,
    term: wire.term,
    calendar: wire.calendar,
    phase: wire.phase,
    reputation: wire.reputation,
    villagers: new Map(wire.villagers.map((v) => [v.id, v])),
    incident: wire.incident,
    trial: wire.trial,
    trialDayKey: wire.trialDayKey ?? null,
    scheduledIncident: wire.scheduledIncident ?? null,
    scheduledParty: wire.scheduledParty ?? null,
    villageRules: wire.villageRules ?? [],
    behaviorRules: wire.behaviorRules ?? defaultBehaviorRules(),
    items: wire.items ?? [],
    placeStates: wire.placeStates ?? [],
    plotThreads: wire.plotThreads ?? [],
    mayorId: wire.mayorId ?? null,
    mayorTermsLeft: wire.mayorTermsLeft ?? 0,
    mayorPoll: wire.mayorPoll ?? null,
    residentHistory: wire.residentHistory ?? [],
    relationships: wire.relationships ?? [],
    userFaith: wire.userFaith ?? [],
    villagerActionLog: wire.villagerActionLog ?? [],
  };
  if (wire.martial !== undefined) world.martial = wire.martial;
  return world;
}

/** 現スナップショット形式のバージョン。型が壊れる変更時に増やし、古い snapshot を破棄する。 */
// v5: BehaviorRule.expiresAtTerm/source='card' + Villager.hiddenUntilTerm (§v1.3-A カードパック)。
// v6: World.martial (§v1.3-C 政治パック 戒厳令)。
// v7: Villager.wealth/hobby/admireId/scummy (§15 住民経済)。
// v8: World.items (§16 フィールドアイテム)。
// v9: World.mayorId/mayorTermsLeft/mayorPoll (§17 村人村長の選挙)。
// userFaith は欠落時に [] で復元できる追加フィールドなので v11 のまま互換維持。
export const WORLD_SNAPSHOT_VERSION = 11;

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

/**
 * テーマパック (§v1.4-D LexiconPack) の語彙。server が data/theme/<pack>/lexicon.json から
 * ロードし (キー欠落は fail-fast)、theme メッセージで client へ配る。sim は不変。
 */
export interface ThemeLexicon {
  /** パックの表示名 (例: クラシック / 精霊の森)。 */
  packName: string;
  /** 開廷の見出し (例: 審判の時 / 禊の儀)。 */
  trialOpen: string;
  stageFoolish: string;
  stageFate: string;
  stageDecided: string;
  verdictDeathJa: string;
  verdictDeathEn: string;
  verdictEducateJa: string;
  verdictEducateEn: string;
  verdictDeathResult: string;
  verdictEducateResult: string;
  /** feed の判決行の接頭辞 (例: 判決 / 御宣託)。chronicle の分類にも使う。 */
  verdictFeedPrefix: string;
  /** 制裁の feed 行 ({name} を差し込む)。 */
  sanctionFeed: string;
  /** プレイヤーの罵倒/擁護、法廷の定型糾弾 ({d}=被告)/やり返し ({t}=相手)、断末魔/安堵。 */
  taunts: string[];
  defenses: string[];
  denounces: string[];
  retorts: string[];
  screams: string[];
  reliefs: string[];
  /** 狂人の表示名 (例: 狂人 / いたずら妖精)。 */
  madmanLabel: string;
  /** 毒饅頭コマンドの表示名。 */
  giftPoisonLabel: string;
  /** Haiku 糾弾生成に足すトーン指示。 */
  denounceTone: string;
  /** 糾弾レパートリーの種セリフ。 */
  denounceSeeds: string[];
}

/** 裁判の糾弾セリフ (server が生成/再利用して配る)。 */
export interface TrialLine {
  speaker: string; // 糾弾する村人 id
  text: string;
}

/** 村の歴史エントリの種別 (§8 タブ分類)。絵文字接頭辞でなく生成元が明示する。 */
export type ChronicleKind =
  | 'event'
  | 'incident'
  | 'trial'
  | 'verdict'
  | 'reform'
  | 'villager'
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
  /** ユーザー参加型イベントの再生用ID。 */
  eventId?: string;
  /** イベントタイトル。 */
  title?: string;
  /** 村の歴史から読み返すための進行記録。 */
  replay?: string[];
  /** 人間参加者とLLM操作BOT。 */
  participants?: string[];
}

/** 人間の行動記録の 1 エントリ (§8 村の歴史「人間の行動記録」)。 */
export interface PlayerActionEntry {
  /** ゲーム内日付 (例 "6月12日")。 */
  date: string;
  userId: string;
  type:
    | 'incite'
    | 'sanction'
    | 'cheer'
    | 'champion'
    | 'villagerGacha'
    | 'placeItem'
    | 'addRule'
    | 'removeRule'
    | 'card'
    | 'insure'
    | 'buyMarket'
    | 'recallMayor'
    | 'proposeLaw'
    | 'voteLaw'
    | 'revolt'
    | 'martial'
    | 'pray'
    | 'raidStrike'
    | 'heckle'
    | 'testify'
    | 'gift'
    | 'spot'
    | 'fanFlames';
  /** 介入対象または公開表示する内容。 */
  target: string;
}

/** 接続ユーザのカルマ/善性状態 (per-connection 配信)。 */
export interface PlayerState {
  /** 現在のカルマ (操作の通貨)。 */
  karma: number;
  /** プレイヤー善性 (応援で上がり、制裁コストを重くする)。 */
  virtue: number;
  /** 表示名。未設定なら null。 */
  userName: string | null;
  /** いま制裁に必要なカルマ (善性込みの実コスト)。 */
  sanctionCost: number;
  /** いま扇動に必要なカルマ (固定コスト)。 */
  inciteCost: number;
  /** 次に応援できるまでの残りミリ秒 (0 = いま可能)。 */
  canCheerInMs: number;
  /** 野次の固定コスト。 */
  heckleCost: number;
  /** 次に野次できるまでの残りミリ秒。 */
  canHeckleInMs: number;
  /** 証言の固定コスト。 */
  testifyCost: number;
  /** 差し入れの固定コスト。 */
  giftTreatCost: number;
  /** 毒饅頭の固定コスト。 */
  giftPoisonCost: number;
  /** 場所介入の固定コスト。 */
  spotCost: number;
  /** 噂の増幅の固定コスト。 */
  fanFlamesCost: number;
  /** 推し (champion) の villager id。未指名は null。 */
  championId: string | null;
  /** 推しの名前。 */
  championName?: string;
  /** 累計課金額 (§v1.3-F 課金モック)。topup でカルマと共に増える。 */
  spent: number;
  /** 月次配布されるイベントカードの所持数。 */
  eventCards: number;
  /** 今日まだ通常介入を使えるか。false のとき介入メニューはグレーアウトする。 */
  canIntervene: boolean;
}

/** オークション (§v1.3-B ②) の 1 ロットの配信形。 */
export interface AuctionLotView {
  /** ロット id (現アクティブロットの種別)。 */
  id: string;
  /** ロットの表示名 (効果の説明)。 */
  title: string;
  /** 現在の最高入札額。未入札は 0。 */
  highBid: number;
  /** 現在の最高入札者 userId。未入札は null。 */
  highUserId: string | null;
  /** 締切までの残りミリ秒。 */
  endsInMs: number;
}

/** 法案 (§v1.3-C ⑦) の配信形。投票中の 1 件。 */
export interface LawView {
  id: string;
  text: string;
  /** 賛成票数。 */
  yes: number;
  /** 反対票数。 */
  no: number;
  /** 締切までの残りミリ秒。 */
  endsInMs: number;
}

/** 実績カウンタ (§4.1)。称号・陣営推定の素材。既定は全 0。 */
export interface PlayerStats {
  /** 扇動した回数。 */
  incites: number;
  /** 制裁した回数。 */
  sanctions: number;
  /** 応援した回数。 */
  cheers: number;
  /** しきたりを追加した回数。 */
  rulesAdded: number;
  /** 裁判へ参加した回数。 */
  trialVotes: number;
  /** 推しが死んだ回数 (§1)。 */
  championDeaths: number;
}

/** 二大陣営 (§4.3)。善導 = guide / 扇動 = incite。 */
export type Faction = 'guide' | 'incite';

/** ハイライトカード (§v1.3-D ㉑)。節目をカード化して共有用に整形する。 */
export interface HighlightCard {
  /** ゲーム内日付 (例 "6月12日")。 */
  date: string;
  /** カードの見出し (短い節目ラベル)。 */
  title: string;
  /** 種別 (chronicle と同じ分類)。 */
  kind: ChronicleKind;
  /** 出来事の要約 (本文)。 */
  summary: string;
}

/** シーズン (§v1.3-D ㉚) の勝敗。guide=善導 / incite=扇動 / draw=引き分け。 */
export type SeasonWinner = 'guide' | 'incite' | 'draw';

/** リーダーボードの 1 行 (§4.3, broadcast)。 */
export interface LeaderboardEntry {
  userId: string;
  /** 表示名。未設定なら null。 */
  userName: string | null;
  /** 主称号 (最大保持者のみ。無ければ null, §4.2)。 */
  title: string | null;
  /** 陣営 (明示選択 or 行動推定)。 */
  faction: Faction;
  karma: number;
  virtue: number;
  stats: PlayerStats;
  /** 累計課金額 (§v1.3-F 課金モック)。状態一覧に ¥ 表記で出す。 */
  spent: number;
  /** 推し (champion) の villager id。未指名は null。 */
  championId: string | null;
}

/** チャットチャンネル。村ログは WS chat ではなくクライアント側ログとして扱う。 */
export type ChatChannel = 'god' | 'human' | 'dm';

/** チャット発言者の種別。 */
export type ChatSpeakerKind = 'human' | 'villager' | 'system';

/** ユーザー間/神の声/DM チャットの 1 件。 */
export interface ChatMessage {
  id: string;
  channel: ChatChannel;
  speakerKind: ChatSpeakerKind;
  userId: string;
  userName: string | null;
  text: string;
  at: number;
  villagerId?: string;
  dmWithVillagerId?: string;
  keywords?: string[];
}

/** 他ユーザーの裁判の声。住民が信仰しているユーザーには応答が付く。 */
export interface TrialVoice {
  id: string;
  userId: string;
  userName: string | null;
  pick: 'kill' | 'spare';
  text: string;
  at: number;
  respondentId?: string;
  responseText?: string;
  faith?: number;
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
  | { t: 'trialVoices'; incidentId: string; voices: TrialVoice[] } // 他ユーザーの裁判の声と住民の応答
  | { t: 'llm'; info: LlmInfo } // 稼働中の LLM 構成
  | { t: 'chronicle'; entries: ChronicleEntry[] } // 村の歴史
  | { t: 'eventTitle'; title: string; subtitle?: string; kind: 'mystery' | 'trial' | 'life'; at: number }
  | { t: 'theme'; pack: string; moral: MoralDial; lexicon: ThemeLexicon } // テーマパック (§v1.4-D, 接続時+起動時)
  | {
      t: 'playerState'; // その接続ユーザの状態
      karma: number;
      virtue: number;
      /** 表示名。未設定なら null。 */
      userName: string | null;
      sanctionCost: number;
      /** いま扇動に必要なカルマ (固定コスト, §4 消費カルマ表示用)。 */
      inciteCost: number;
      canCheerInMs: number;
      /** 今日まだ通常介入を使えるか。false のとき通常介入メニューはグレーアウトする。 */
      canIntervene: boolean;
      // --- 即効介入 (§v1.4-A) のコスト/クールダウン表示用 ---
      /** 野次の固定コスト。 */
      heckleCost: number;
      /** 次に野次できるまでの残りミリ秒 (0 = いま可能)。 */
      canHeckleInMs: number;
      /** 証言の固定コスト。 */
      testifyCost: number;
      /** 差し入れ (treat) の固定コスト。 */
      giftTreatCost: number;
      /** 毒饅頭 (poison) の固定コスト。 */
      giftPoisonCost: number;
      /** 場所を荒らす/清める (spot) の固定コスト。 */
      spotCost: number;
      /** 噂の増幅 (fanFlames) の固定コスト。 */
      fanFlamesCost: number;
      /** 推し (champion) の villager id。未指名は null (§1)。 */
      championId?: string | null;
      /** 推しの名前 (index が world から補完)。未指名/不在なら省略。 */
      championName?: string;
      /** 累計課金額 (§v1.3-F 課金モック)。 */
      spent: number;
      /** 月次配布されるイベントカードの所持数。 */
      eventCards: number;
    }
  | { t: 'loggedOut'; reason: string } // 別端末ログインで現セッションが追い出された (§v1.3-F)
  | { t: 'auction'; lots: AuctionLotView[] } // オークションのロット状態 (§v1.3-B ②, broadcast)
  | { t: 'commandRejected'; reason: string } // カルマ不足/インターバル中など
  | {
      t: 'leaderboard'; // 称号・陣営のスコアボード (§4, broadcast)
      players: LeaderboardEntry[];
      /** 村の徳目綱引き (§4.3): guide=(善良+秩序)×100 / incite=悪辣×100。 */
      factions: { guide: number; incite: number };
    }
  | { t: 'chat'; messages: ChatMessage[] } // ユーザー間チャット
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
    }
  // --- 政治パック (§v1.3-C) ---
  // 村長 (§17) は WireWorld (mayorId/mayorTermsLeft/mayorPoll) に乗って snapshot で配信する。
  | { t: 'laws'; items: LawView[] } // 投票中の法案一覧 (⑦, broadcast)
  | { t: 'revolt'; active: boolean; incite: number; suppress: number; endsInMs: number } // 革命の蜂起状態 (⑧, broadcast)
  | { t: 'martial'; mode: MartialMode | null; endsInMs: number } // 戒厳令の発動状態 (⑨, broadcast)
  | { t: 'fund'; amount: number; threshold: number } // 村基金の残高 (⑩, broadcast)
  // --- 演出・協力パック (§v1.3-D) ---
  | { t: 'highlights'; cards: HighlightCard[] } // ハイライト一覧 (㉑, broadcast)
  | { t: 'mvp'; villagerId: string; name: string } // 月間MVP (㉔, broadcast)
  | { t: 'raid'; active: boolean; villainName: string; hp: number; hpMax: number; endsInMs: number } // 共闘レイド (㉙, broadcast)
  | { t: 'season'; number: number; winner: SeasonWinner; leaderboard: LeaderboardEntry[] }; // シーズン確定 (㉚, broadcast)

/** カードパック (§v1.3-A) の 5 種。 */
export type CardName = 'disaster' | 'spiritAway' | 'swap' | 'awaken' | 'falseProphecy';

/** 闇市 (§v1.3-B ⑤) で買える品目。revive=死者復活 / card_*=カードパックの効果を割引購入。 */
export type MarketItem = 'revive' | 'card_disaster' | 'card_swap' | 'card_awaken' | 'card_prophecy';

/** client → server。 */
export type ClientMessage =
  | { t: 'hello'; userId: string; userName?: string } // 接続とユーザを紐付け (per-user カルマ push 用)
  | { t: 'login'; code: string } // 別端末のユーザーコード (=userId UUIDv4) で現接続を束ね直す (§v1.3-F)
  | { t: 'setUserName'; name: string; userId?: string } // ユーザー名を設定する (§v1.3-F)
  | { t: 'chat'; text: string; userId?: string; channel?: ChatChannel; dmWithVillagerId?: string } // ユーザー間/神の声/DM チャット
  | { t: 'topup'; amount: number; userId?: string } // 課金モック (§v1.3-F): 固定パックでカルマ+課金額を増やす
  | { t: 'incite'; targetId: string; rumorAboutId?: string; userId?: string } // 対象に偽情報を吹き込み事件化を促す (§4.2)
  | { t: 'sanction'; targetId: string; userId?: string } // 対象を即時つるし上げ裁判にかける (§4.3)
  | { t: 'cheer'; targetId: string; userId?: string } // 対象の気質を後押しする (§4.5)
  // --- 即効介入 (§v1.4-A): 短期に見えて環境に爪痕を残す操作 ---
  | { t: 'heckle'; side: 'agitate' | 'soothe'; userId?: string } // 進行中の事件へ野次を飛ばす
  | { t: 'testify'; stance: 'accuse' | 'defend'; text?: string; userId?: string } // 裁判の fate 段階へ証言を投げ込む
  | { t: 'gift'; targetId: string; kind: 'treat' | 'poison'; userId?: string } // 差し入れ/毒饅頭を手渡す
  | { t: 'spot'; place: string; mode: 'defile' | 'bless'; userId?: string } // 場所を荒らす/清める (§v1.4-A')
  | { t: 'fanFlames'; targetId: string; userId?: string } // 対象の噂を近傍へ言いふらす (§v1.4-A')
  | { t: 'vote'; pick: string; userId?: string } // 裁判への 1 票 (foolish=候補id / fate='kill'|'spare')。userId で接続ユーザを区別 (重み合算)
  | { t: 'champion'; targetId: string; userId?: string } // 推しを 1 体指名 (§1)。再送で差し替え
  | { t: 'villagerGacha'; kind: VillagerGachaKind; userId?: string }
  // フィールドアイテム配置 (§16)。カルマ消費なし・ランダム配布。kind='random'|'precious'|'drug'。
  // toChampion=true なら推しに直接送る (フィールドを介さない)。
  | { t: 'placeItem'; kind: 'random' | 'precious' | 'drug'; toChampion?: boolean; userId?: string }
  | { t: 'addRule'; text: string; userId?: string } // カルマを払って村のしきたりを 1 件追加 (§2)
  | { t: 'removeRule'; ruleId: string; userId?: string } // カルマを払って村のしきたりを 1 件廃する (§2)
  | { t: 'faction'; side: 'guide' | 'incite'; userId?: string } // 二大陣営を明示選択 (§4.3)
  // カードパック (§v1.3-A): カルマで切る一発介入。card 別に必要な引数だけ伴う。
  // disaster=kind / spiritAway=targetId / swap=targetId(a)+targetId2(b) / awaken=targetId / falseProphecy=text?
  | { t: 'card'; card: CardName; targetId?: string; targetId2?: string; kind?: string; text?: string; userId?: string }
  | { t: 'eventCard'; userId?: string } // 月次配布カードを 1 枚消費してガチャ効果を起こす
  // 経済パック (§v1.3-B): カルマ経済 (銀行/預金は廃止)。
  | { t: 'insure'; targetId: string; premium: number; userId?: string } // 推し保険を掛ける (§v1.3-B ③)
  | { t: 'buyMarket'; item: MarketItem; targetId?: string; targetId2?: string; kind?: string; userId?: string } // 闇市で購入 (§v1.3-B ⑤)
  | { t: 'bid'; lotId: string; amount: number; userId?: string } // オークション入札 (§v1.3-B ②)
  // 政治パック (§v1.3-C): 統治。
  | { t: 'recallMayor'; userId?: string } // 村長リコール請求 (§17)。成功率は支持率+過去の事件
  | { t: 'proposeLaw'; text: string; userId?: string } // 法案を供託カルマ付きで提案 (⑦)
  | { t: 'voteLaw'; lawId: string; approve: boolean; userId?: string } // 法案へ賛成/反対 (⑦)
  | { t: 'revolt'; side: 'incite' | 'suppress'; userId?: string } // 蜂起にカルマを投じる (⑧)
  | { t: 'martial'; mode: MartialMode; userId?: string } // 戒厳令にカルマを投じる (⑨)
  // 演出・協力パック (§v1.3-D): 予測 / MVP / 祈り / レイド。
  | { t: 'predictDay'; dayOfMonth: number; userId?: string } // 今月の事件発生日を予測 (㉓)
  | { t: 'voteMvp'; villagerId: string; userId?: string } // 月間MVP に住民を投票 (㉔)
  | { t: 'pray'; userId?: string } // 観客の祈り (㉕, 協力バフ)
  | { t: 'raidStrike'; amount: number; userId?: string }; // 共闘レイドにカルマを投じて削る (㉙)
