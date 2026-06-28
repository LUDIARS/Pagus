// Pagus の設定スキーマと暗号化 config ローダ.
//
// 旧来 server 全体に散っていた ~60 個の `PAGUS_*` env (numEnv/process.env) を、単一の暗号化
// config (data/runtime/pagus.config.enc, SecretBox = AES-256-GCM) に集約する. 値は index で 1 回
// loadPagusConfig() し、各モジュールへコンストラクタ注入する (各モジュールは env を読まない).
//
// 無言フォールバック禁止 (RULE_CODE §7.1): 復号失敗 / JSON 不正 / 型不正は throw. ファイルが
// 無いときだけは DEFAULT_CONFIG を返す (これは「正規の既定値」であって劣化フォールバックではない).
//
// 秘密 (§14): VAPID 鍵も config に含める. enc ファイルも鍵ファイルもリポにコミットしない
// (data/runtime/ は gitignore 済).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from '../load-data.js';
import { SecretBox, resolveSecretKey } from './secret-box.js';

/** シミュレーション核 (TermMachine / StubBrain / RuleGen) のチューニング. */
export interface SimConfig {
  /** 日常エンジンが自由行動を事件化する閾値 / StubBrain の triggerAfter (PAGUS_TRIGGER_AFTER). */
  triggerAfter: number;
  /** EventDirector の 1 セグメント最大反復 (PAGUS_REPS). */
  reps: number;
  /** 事件が和解で収まる基礎確率 (PAGUS_RECONCILE). */
  reconcileChance: number;
  /** 二次被害の確率 (PAGUS_SECONDARY). */
  secondaryChance: number;
  /** ストレス耐性で嫌がらせを受け流す効き (PAGUS_STRESS_K). */
  stressFizzleK: number;
  /** 日末の結婚確率 (PAGUS_MARRIAGE). */
  marriageChance: number;
  /** 日末の出産確率 (PAGUS_BIRTH). */
  birthChance: number;
  /** ふるまいの法則の上限 (PAGUS_RULES_MAX). */
  rulesMax: number;
  /** 戒厳令 surge の事件化閾値ボーナス (PAGUS_MARTIAL_SURGE). */
  martialSurgeBonus: number;
  /** ふるまいの法則の Haiku 増殖が有効か (PAGUS_RULEGEN). */
  rulegenEnabled: boolean;
  /** 日末に増殖を試みる確率 (PAGUS_RULEGEN_CHANCE). */
  rulegenChance: number;
}

/** プレイヤーのカルマ/善性 (PlayerState). */
export interface KarmaConfig {
  /** 毎秒のカルマ加算量 (PAGUS_KARMA_RATE). */
  rate: number;
  /** カルマ上限 (PAGUS_KARMA_MAX). */
  max: number;
  /** 扇動コスト (PAGUS_INCITE_COST). */
  inciteCost: number;
  /** 制裁コスト基準 (PAGUS_SANCTION_COST). */
  sanctionCost: number;
  /** 善性による制裁コスト係数 (PAGUS_SANCTION_VIRTUE_K). */
  sanctionVirtueK: number;
  /** 応援インターバル ms (PAGUS_CHEER_INTERVAL_MS). */
  cheerIntervalMs: number;
  /** 応援 1 回の善性上昇 (PAGUS_CHEER_VIRTUE). */
  cheerVirtue: number;
  /** 推し生存中のカルマ加速倍率 (PAGUS_CHAMPION_KARMA_MULT). */
  championKarmaMult: number;
  /** 推しの死のカルマ罰 (PAGUS_CHAMPION_DEATH_PENALTY). */
  championDeathPenalty: number;
  /** 送金手数料 (%) (PAGUS_TRANSFER_FEE_PCT). */
  transferFeePct: number;
  /** カード使用クールダウン ms (PAGUS_CARD_COOLDOWN_MS). */
  cardCooldownMs: number;
}

/** カードパック (§v1.3-A). */
export interface CardsConfig {
  disasterCost: number; // PAGUS_CARD_DISASTER_COST
  spiritAwayCost: number; // PAGUS_CARD_SPIRITAWAY_COST
  swapCost: number; // PAGUS_CARD_SWAP_COST
  awakenCost: number; // PAGUS_CARD_AWAKEN_COST
  prophecyCost: number; // PAGUS_CARD_PROPHECY_COST
  disasterDays: number; // PAGUS_DISASTER_DAYS
  spiritAwayDays: number; // PAGUS_SPIRITAWAY_DAYS
}

/** 経済パック (§v1.3-B) + ベット/しきたり改定/課金. */
export interface EconomyConfig {
  bankInterest: number; // PAGUS_BANK_INTEREST
  insureDays: number; // PAGUS_INSURE_DAYS
  insureMult: number; // PAGUS_INSURE_MULT
  reviveCost: number; // PAGUS_REVIVE_COST
  auctionPeriodMs: number; // PAGUS_AUCTION_PERIOD_MS
  marketPremium: number; // PAGUS_MARKET_PREMIUM
  betMin: number; // PAGUS_BET_MIN
  ruleAddCost: number; // PAGUS_RULE_ADD_COST
  ruleRemoveCost: number; // PAGUS_RULE_REMOVE_COST
  villageRulesMax: number; // PAGUS_VILLAGE_RULES_MAX
  /** 許可する固定課金パック (PAGUS_TOPUP_PACKS). 正の整数のみ. */
  topupPacks: number[];
}

/** 政治パック (§v1.3-C). */
export interface PoliticsConfig {
  revoltThreshold: number; // PAGUS_REVOLT_THRESHOLD
  martialDays: number; // PAGUS_MARTIAL_DAYS
  mayorPeriodMs: number; // PAGUS_MAYOR_PERIOD_MS
  lawDeposit: number; // PAGUS_LAW_DEPOSIT
  lawVoteMs: number; // PAGUS_LAW_VOTE_MS
  revoltStake: number; // PAGUS_REVOLT_STAKE
  revoltWindowMs: number; // PAGUS_REVOLT_WINDOW_MS
  martialStake: number; // PAGUS_MARTIAL_STAKE
  martialCost: number; // PAGUS_MARTIAL_COST
  taxPeriodMs: number; // PAGUS_TAX_PERIOD_MS
  taxAmount: number; // PAGUS_TAX_AMOUNT
  fundThreshold: number; // PAGUS_FUND_THRESHOLD
}

/** 演出・協力パック (§v1.3-D). */
export interface SpectacleConfig {
  predictReward: number; // PAGUS_PREDICT_REWARD
  prayWindowMs: number; // PAGUS_PRAY_WINDOW_MS
  prayNeeded: number; // PAGUS_PRAY_NEEDED
  seasonMonths: number; // PAGUS_SEASON_MONTHS
  seasonReward: number; // PAGUS_SEASON_REWARD
  raidChance: number; // PAGUS_RAID_CHANCE
  raidHp: number; // PAGUS_RAID_HP
  raidWindowMs: number; // PAGUS_RAID_WINDOW_MS
  raidReward: number; // PAGUS_RAID_REWARD
}

/** LLM 駆動の運用設定. */
export interface LlmConfig {
  /** CLI の一過性失敗リトライ回数 (PAGUS_CLI_RETRIES). */
  cliRetries: number;
  /** codex(gpt-5.5) をキャストから外すか (PAGUS_DISABLE_CODEX). */
  disableCodex: boolean;
}

/** WebPush 通知 (§4.8) の秘密. VAPID 鍵は空なら無効. */
export interface PushConfig {
  /** push 通知を有効化するか (PAGUS_PUSH). 鍵欠落で有効なら起動時に throw. */
  enabled: boolean;
  /** VAPID 公開鍵 (秘密, PAGUS_VAPID_PUBLIC). 空=未設定. */
  vapidPublic: string;
  /** VAPID 秘密鍵 (秘密, PAGUS_VAPID_PRIVATE). 空=未設定. */
  vapidPrivate: string;
  /** VAPID subject (PAGUS_VAPID_SUBJECT). */
  vapidSubject: string;
}

/** サーバ運用 (ポート/加速/ログ). */
export interface ServerConfig {
  wsPort: number; // PAGUS_WS_PORT
  accel: number; // PAGUS_ACCEL
  minMs: number; // PAGUS_MIN_MS
  incidentStepMs: number; // PAGUS_INCIDENT_MS
  /** stdout エコー (PAGUS_LOG_STDOUT). */
  logStdout: boolean;
  /** JSONL 永続化 (PAGUS_LOG_FILE). */
  logFile: boolean;
  /** ログ出力先 (PAGUS_LOG_DIR). 空=既定 (<repo>/logs). */
  logDir: string;
}

/** Pagus の全設定 (旧 PAGUS_* env の集約先). */
export interface PagusConfig {
  sim: SimConfig;
  karma: KarmaConfig;
  cards: CardsConfig;
  economy: EconomyConfig;
  politics: PoliticsConfig;
  spectacle: SpectacleConfig;
  llm: LlmConfig;
  push: PushConfig;
  server: ServerConfig;
}

/** 現行の既定値 (各 numEnv の第2引数 / env 既定をそのまま写したもの). */
export const DEFAULT_CONFIG: PagusConfig = {
  sim: {
    triggerAfter: 6,
    reps: 3,
    reconcileChance: 0.15,
    secondaryChance: 0.18,
    stressFizzleK: 0.06,
    marriageChance: 0.12,
    birthChance: 0.1,
    rulesMax: 40,
    martialSurgeBonus: 4,
    rulegenEnabled: true,
    rulegenChance: 0.15,
  },
  karma: {
    rate: 0.5,
    max: 100,
    inciteCost: 10,
    sanctionCost: 30,
    sanctionVirtueK: 1,
    cheerIntervalMs: 180000,
    cheerVirtue: 0.05,
    championKarmaMult: 1.5,
    championDeathPenalty: 20,
    transferFeePct: 0,
    cardCooldownMs: 60000,
  },
  cards: {
    disasterCost: 40,
    spiritAwayCost: 35,
    swapCost: 30,
    awakenCost: 25,
    prophecyCost: 20,
    disasterDays: 3,
    spiritAwayDays: 2,
  },
  economy: {
    bankInterest: 0.02,
    insureDays: 5,
    insureMult: 3,
    reviveCost: 80,
    auctionPeriodMs: 120000,
    marketPremium: 1.5,
    betMin: 1,
    ruleAddCost: 15,
    ruleRemoveCost: 25,
    villageRulesMax: 12,
    topupPacks: [100, 500, 1000],
  },
  politics: {
    revoltThreshold: 0.7,
    martialDays: 2,
    mayorPeriodMs: 180000,
    lawDeposit: 20,
    lawVoteMs: 60000,
    revoltStake: 10,
    revoltWindowMs: 60000,
    martialStake: 25,
    martialCost: 100,
    taxPeriodMs: 180000,
    taxAmount: 5,
    fundThreshold: 100,
  },
  spectacle: {
    predictReward: 30,
    prayWindowMs: 30000,
    prayNeeded: 3,
    seasonMonths: 3,
    seasonReward: 50,
    raidChance: 0.05,
    raidHp: 100,
    raidWindowMs: 120000,
    raidReward: 50,
  },
  llm: {
    cliRetries: 2,
    disableCodex: false,
  },
  push: {
    enabled: false,
    vapidPublic: '',
    vapidPrivate: '',
    vapidSubject: 'mailto:pagus@vtn-game.com',
  },
  server: {
    wsPort: 4310,
    accel: 600,
    minMs: 400,
    incidentStepMs: 700,
    logStdout: true,
    logFile: true,
    logDir: '',
  },
};

/** 既定の鍵ファイル (env passphrase が無いときに使う). */
export function defaultKeyFile(): string {
  return resolve(dataDir(), 'runtime', 'pagus.config.key');
}

/** 既定の暗号化 config ファイル. */
export function defaultEncFile(): string {
  return resolve(dataDir(), 'runtime', 'pagus.config.enc');
}

/** plain object か (配列/null を除く). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * DEFAULT_CONFIG をスキーマとして、部分指定の override を deep merge する.
 * - 既定に無いキー: warn して無視 (不明キーは無視 or warn).
 * - 型不一致 (number↔string↔boolean): throw (無言フォールバック禁止).
 * - 配列: 要素型 (既定先頭要素の typeof) を全要素に要求, 不一致は throw.
 * 戻りは defaults のクローンに override を重ねた新オブジェクト.
 */
function mergeInto<T>(defaults: T, override: unknown, path: string): T {
  if (override === undefined) return structuredClone(defaults);
  if (!isPlainObject(defaults)) {
    // ここに来るのは呼び出し側の使い方ミス (defaults は常にオブジェクト).
    throw new Error(`config 内部エラー: ${path} の既定がオブジェクトではありません`);
  }
  if (!isPlainObject(override)) {
    throw new Error(`config の ${path} はオブジェクトである必要があります`);
  }
  const result = structuredClone(defaults) as Record<string, unknown>;
  const def = defaults as Record<string, unknown>;
  for (const [key, ov] of Object.entries(override)) {
    const here = path ? `${path}.${key}` : key;
    if (!(key in def)) {
      console.warn(`[pagus] config: 不明なキー ${here} を無視します`);
      continue;
    }
    const dv = def[key];
    if (Array.isArray(dv)) {
      if (!Array.isArray(ov)) throw new Error(`config の ${here} は配列である必要があります`);
      const elemType = typeof dv[0];
      for (const [i, el] of ov.entries()) {
        if (typeof el !== elemType) {
          throw new Error(`config の ${here}[${i}] の型が不正です (期待: ${elemType})`);
        }
      }
      result[key] = [...ov];
    } else if (isPlainObject(dv)) {
      result[key] = mergeInto(dv, ov, here);
    } else {
      if (typeof ov !== typeof dv) {
        throw new Error(`config の ${here} の型が不正です (期待: ${typeof dv}, 実際: ${typeof ov})`);
      }
      result[key] = ov;
    }
  }
  return result as T;
}

/**
 * 部分指定の JSON を DEFAULT_CONFIG へ deep merge して完全な PagusConfig にする.
 * 型不一致は throw, 不明キーは warn して無視 (ファイル I/O から切り離してテスト可能).
 */
export function mergePagusConfig(partial: unknown): PagusConfig {
  return mergeInto(DEFAULT_CONFIG, partial, '');
}

/** loadPagusConfig の差し替え可能なパス (テストで tmp を指す). */
export interface LoadConfigOptions {
  /** 暗号化 config ファイル (既定 data/runtime/pagus.config.enc). */
  encFile?: string;
  /** 鍵ファイル (既定 data/runtime/pagus.config.key). */
  keyFile?: string;
  /** env passphrase (既定 process.env.PAGUS_CONFIG_KEY). null で無効化. */
  envKey?: string | null;
}

/**
 * 暗号化 config を読み込む.
 *  - ファイルがあれば: SecretBox で復号 → JSON.parse → DEFAULT_CONFIG へ deep merge して返す.
 *    復号失敗 / JSON 不正 / 型不正は throw (fail-fast, 無言フォールバック禁止).
 *  - ファイルが無ければ: DEFAULT_CONFIG を返しつつ警告 (正規の既定値で起動).
 */
export function loadPagusConfig(opts: LoadConfigOptions = {}): PagusConfig {
  const encFile = opts.encFile ?? defaultEncFile();
  const keyFile = opts.keyFile ?? defaultKeyFile();
  const envKey = opts.envKey === undefined ? (process.env.PAGUS_CONFIG_KEY ?? null) : opts.envKey;

  if (!existsSync(encFile)) {
    console.warn(
      '[pagus] 暗号化 config 未作成 — 既定値で起動。`pnpm pagus:config init` で作成',
    );
    return structuredClone(DEFAULT_CONFIG);
  }

  const enc = readFileSync(encFile, 'utf8').trim();
  const box = new SecretBox(resolveSecretKey({ envValue: envKey, keyFile }));
  // 復号失敗 (鍵違い/改竄) は SecretBox が throw → そのまま伝播 (握り潰さない).
  const plain = box.decrypt(enc);

  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch (cause) {
    throw new Error(`config の JSON parse に失敗しました: ${encFile}`, { cause });
  }
  return mergePagusConfig(parsed);
}
