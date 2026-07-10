// Pagus の設定スキーマと暗号化 config ローダ.
//
// 旧来 server 全体に散っていた ~70 個の `PAGUS_*` env (numEnv/process.env) を、LUDIARS 正本の
// 共有パッケージ `@ludiars/encrypted-config` (Lapilli, AES-256-GCM + scrypt) による単一の
// config (data/runtime/pagus.config.json) に集約する. 値は index で 1 回 loadPagusConfig() し、
// 各モジュールへコンストラクタ注入する (各モジュールは env を読まない).
//
// 形式 (パッケージ準拠): { plain: {<dotkey>: 文字列}, secrets: {<dotkey>: EncryptedBlob} }.
//   - 非シークセット (チューニング値) は dot-path キー (例 "karma.rate") で plain に平文保存.
//   - シークレット (VAPID 秘密鍵) は secretKeys に入れ AES-256-GCM で暗号化保存.
// master secret: env `PAGUS_MASTER_KEY` → 無ければマシン束縛値 `pagus:hostname:user`
//   (Canalis/Excubitor と同方式. 別マシンへ持ち出すなら PAGUS_MASTER_KEY を共有する).
//
// 無言フォールバック禁止 (RULE_CODE §7.1): 型不正は throw. ファイルが無いときだけ DEFAULT_CONFIG
// を返す (これは「正規の既定値」であって劣化フォールバックではない).
//
// 秘密 (§14): config ファイルはリポにコミットしない (data/runtime/ は gitignore 済).

import { resolve } from 'node:path';
import { readConfig, type StoreOptions } from '@ludiars/encrypted-config';
import { dataDir } from '../load-data.js';

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

/** 経済パック (§v1.3-B) + しきたり改定/課金. */
export interface EconomyConfig {
  insureDays: number; // PAGUS_INSURE_DAYS
  insureMult: number; // PAGUS_INSURE_MULT
  reviveCost: number; // PAGUS_REVIVE_COST
  auctionPeriodMs: number; // PAGUS_AUCTION_PERIOD_MS
  marketPremium: number; // PAGUS_MARKET_PREMIUM
  ruleAddCost: number; // PAGUS_RULE_ADD_COST
  ruleRemoveCost: number; // PAGUS_RULE_REMOVE_COST
  villageRulesMax: number; // PAGUS_VILLAGE_RULES_MAX
  /** 許可する固定課金パック (PAGUS_TOPUP_PACKS). 正の整数のみ. */
  topupPacks: number[];
}

/** 即効介入 (§v1.4-A 野次/証言/差し入れ). */
export interface InterveneConfig {
  /** 野次のカルマコスト. */
  heckleCost: number;
  /** 野次の連打クールダウン ms. */
  heckleCooldownMs: number;
  /** 野次 (agitate) 1 回の被害加算. */
  heckleDamage: number;
  /** 野次 1 回が動かす和解バイアス量. */
  heckleBias: number;
  /** 証言のカルマコスト. */
  testifyCost: number;
  /** 差し入れ (treat) のカルマコスト. */
  giftTreatCost: number;
  /** 毒饅頭 (poison) のカルマコスト. */
  giftPoisonCost: number;
  /** 差し入れの所持金増. */
  giftTreatWealth: number;
  /** 差し入れの喜び増 (-1..1 クランプ). */
  giftTreatJoy: number;
  /** 場所を荒らす/清める (spot) のカルマコスト. */
  spotCost: number;
  /** spot の効果日数. */
  spotDays: number;
  /** 荒らした瞬間の怒り増. */
  spotAnger: number;
  /** 清めた瞬間の喜び増. */
  spotJoy: number;
  /** 噂の増幅 (fanFlames) のカルマコスト. */
  fanFlamesCost: number;
}

/** 事件アーク (§v1.4-B 火種/小騒動/裁判バリエーション). */
export interface ArcConfig {
  /** 火種の上限. */
  threadsMax: number;
  /** 火種の日末減衰量. */
  heatDecay: number;
  /** 関係者が事件に絡んだときの加熱量. */
  heatOnIncident: number;
  /** organic 事件化を小騒動に流す確率. */
  minorChance: number;
  /** 小騒動が火種を残す確率. */
  minorResidueChance: number;
  /** 開廷時の目撃者の最大数. */
  witnessMax: number;
  /** 目撃者 1 人の foolish 票の重み. */
  witnessWeight: number;
  /** 冤罪被告の fate 段階で真犯人が発覚する確率. */
  revealChance: number;
}

/** 政治パック (§v1.3-C). */
export interface PoliticsConfig {
  revoltThreshold: number; // PAGUS_REVOLT_THRESHOLD
  martialDays: number; // PAGUS_MARTIAL_DAYS
  recallStake: number; // 村長リコール請願のカルマ費 (§17)
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

/** 蒸留ループ (§v1.4-C shadow sampling → RuleSmith 蒸留 → replay ゲート). */
export interface DistillConfig {
  /** shadow sampling を有効にするか (llm モードで教師呼び出しの追加費用が出る). */
  enabled: boolean;
  /** 日常決定 1 件を教師に影として問う確率. */
  sampleChance: number;
  /** 蒸留を試みる最低乖離ケース数. */
  minCases: number;
  /** 1 回の蒸留に使う最大ケース数. */
  maxCases: number;
  /** replay ゲートの採用条件: 教師一致率がこの値以上改善したら採用. */
  acceptGain: number;
}

/** テーマパック + モラルダイヤル (§v1.4-D). */
export interface ThemeConfig {
  /** テーマパック名 (data/theme/<pack>/lexicon.json). */
  pack: string;
  /** モラルダイヤル: dark | balanced | wholesome (wholesome=死刑無効). */
  moral: string;
}

/** LLM 駆動の運用設定. */
export interface LlmConfig {
  /** CLI の一過性失敗リトライ回数 (PAGUS_CLI_RETRIES). */
  cliRetries: number;
  /** codex(GPT-5.6 Sol/Terra/Luna) をキャストから外すか (PAGUS_DISABLE_CODEX). */
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
  intervene: InterveneConfig;
  arc: ArcConfig;
  theme: ThemeConfig;
  distill: DistillConfig;
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
    insureDays: 5,
    insureMult: 3,
    reviveCost: 80,
    auctionPeriodMs: 120000,
    marketPremium: 1.5,
    ruleAddCost: 15,
    ruleRemoveCost: 25,
    villageRulesMax: 12,
    topupPacks: [100, 500, 1000],
  },
  intervene: {
    heckleCost: 3,
    heckleCooldownMs: 10000,
    heckleDamage: 1,
    heckleBias: 0.08,
    testifyCost: 8,
    giftTreatCost: 5,
    giftPoisonCost: 15,
    giftTreatWealth: 25,
    giftTreatJoy: 0.2,
    spotCost: 20,
    spotDays: 2,
    spotAnger: 0.15,
    spotJoy: 0.15,
    fanFlamesCost: 10,
  },
  arc: {
    threadsMax: 8,
    heatDecay: 0.05,
    heatOnIncident: 0.2,
    minorChance: 0.25,
    minorResidueChance: 0.5,
    witnessMax: 2,
    witnessWeight: 2,
    revealChance: 0.25,
  },
  theme: {
    pack: 'classic',
    moral: 'balanced',
  },
  distill: {
    enabled: true,
    sampleChance: 0.02,
    minCases: 5,
    maxCases: 10,
    acceptGain: 0.1,
  },
  politics: {
    revoltThreshold: 0.7,
    martialDays: 2,
    recallStake: 50,
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

/** 暗号化保存するキー (dot-path). VAPID 秘密鍵のみ暗号化, 公開鍵/subject は平文. */
export const SECRET_KEYS: ReadonlySet<string> = new Set(['push.vapidPrivate']);

/** @ludiars/encrypted-config の StoreOptions (Pagus 用). config パスは env override で渡す. */
export const STORE_OPTIONS: StoreOptions = {
  secretKeys: new Set(SECRET_KEYS),
  configPathEnv: 'PAGUS_CONFIG_PATH',
  masterKeyEnv: 'PAGUS_MASTER_KEY',
  defaultConfigFile: 'pagus.config.json',
  masterSecretPrefix: 'pagus',
};

/** 既定の config ファイル (data/runtime/pagus.config.json, 絶対パス). */
export function defaultConfigPath(): string {
  return resolve(dataDir(), 'runtime', 'pagus.config.json');
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

/** DEFAULT_CONFIG を dot-path で辿り、その位置の既定値を返す (無ければ undefined). */
export function defaultAt(dotpath: string): unknown {
  let cur: unknown = DEFAULT_CONFIG;
  for (const seg of dotpath.split('.')) {
    if (!isPlainObject(cur) || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** DEFAULT_CONFIG を { "a.b": 文字列値 } の flat map に畳む (CLI の init/import 用). 配列は JSON 文字列. */
export function flattenConfig(obj: unknown = DEFAULT_CONFIG, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(obj)) return out;
  for (const [key, val] of Object.entries(obj)) {
    const here = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(val)) Object.assign(out, flattenConfig(val, here));
    else if (Array.isArray(val)) out[here] = JSON.stringify(val);
    else out[here] = String(val);
  }
  return out;
}

/** flat の生文字列を、その dot-path の既定値の型に合わせて変換する (型不正は throw). */
export function coerceLeaf(dotpath: string, raw: string): number | string | boolean | unknown[] {
  const def = defaultAt(dotpath);
  if (Array.isArray(def)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`config の ${dotpath} は JSON 配列である必要があります: ${raw}`, { cause });
    }
    if (!Array.isArray(parsed)) throw new Error(`config の ${dotpath} は配列である必要があります`);
    return parsed;
  }
  switch (typeof def) {
    case 'number': {
      const n = Number(raw);
      if (raw.trim() === '' || Number.isNaN(n)) throw new Error(`config の ${dotpath} が数値ではありません: ${raw}`);
      return n;
    }
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error(`config の ${dotpath} は true|false である必要があります: ${raw}`);
    case 'string':
      return raw;
    default:
      // 既定に無いキー (defaultAt が undefined) は nestFromFlat 側で弾く.
      throw new Error(`config の不明なキー: ${dotpath}`);
  }
}

/** readConfig が返す flat map を、型変換しつつ nested な部分 config に組み立てる. */
function nestFromFlat(flat: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [dotpath, raw] of Object.entries(flat)) {
    if (defaultAt(dotpath) === undefined) {
      console.warn(`[pagus] config: 不明なキー ${dotpath} を無視します`);
      continue;
    }
    const segs = dotpath.split('.');
    let cur = out;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i] as string;
      if (!isPlainObject(cur[seg])) cur[seg] = {};
      cur = cur[seg] as Record<string, unknown>;
    }
    cur[segs[segs.length - 1] as string] = coerceLeaf(dotpath, raw);
  }
  return out;
}

/** loadPagusConfig / CLI の差し替え可能なパス (テストで tmp / 任意 master key を指す). */
export interface LoadConfigOptions {
  /** config ファイルパス (既定 data/runtime/pagus.config.json). */
  configPath?: string;
  /** master secret (既定 env PAGUS_MASTER_KEY → マシン束縛値). */
  masterKey?: string;
}

/** StoreOptions + (configPath/masterKey override を載せた) env を組む.
 * config パスの優先順: 明示 opts > 環境変数 PAGUS_CONFIG_PATH > 既定 (data/runtime/pagus.config.json). */
export function storeEnv(opts: LoadConfigOptions = {}): NodeJS.ProcessEnv {
  const path = opts.configPath ?? process.env.PAGUS_CONFIG_PATH ?? defaultConfigPath();
  const env: NodeJS.ProcessEnv = { ...process.env, PAGUS_CONFIG_PATH: path };
  if (opts.masterKey !== undefined) env.PAGUS_MASTER_KEY = opts.masterKey;
  return env;
}

/**
 * config を読み込む (`@ludiars/encrypted-config` の readConfig 経由).
 *  - ファイルがあれば: plain + 復号した secrets の flat map → 型変換 → DEFAULT_CONFIG へ deep merge.
 *    型不正は throw (fail-fast, 無言フォールバック禁止).
 *  - ファイルが無ければ (readConfig が null): DEFAULT_CONFIG を返しつつ警告 (正規の既定値で起動).
 */
export function loadPagusConfig(opts: LoadConfigOptions = {}): PagusConfig {
  const flat = readConfig(STORE_OPTIONS, storeEnv(opts));
  if (flat === null) {
    console.warn('[pagus] config 未作成 — 既定値で起動。`pnpm pagus:config init` で作成');
    return structuredClone(DEFAULT_CONFIG);
  }
  return mergePagusConfig(nestFromFlat(flat));
}
