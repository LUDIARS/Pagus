// プレイヤーのカルマ/善性を userId ごとに管理する (§4.4)。
// カルマは時間経過で自動でたまり (accrue)、扇動/制裁で消費 (spend) する。
// 善性 (virtue) は応援で上がり、制裁コストを重くする。WS の per-connection 配信で使う。
//
// 設定不備の無言フォールバック禁止 (RULE_CODE §7.1): env が数値でなければ即エラー。

/** env を数値で読む。未設定は fallback、数値でなければ throw (無言フォールバック禁止)。 */
function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`環境変数 ${name} が数値ではありません: ${v}`);
  return n;
}

interface PlayerEntry {
  karma: number;
  virtue: number;
  lastCheerMs: number;
}

/** snapshot/配信に使う 1 ユーザの状態。 */
export interface PlayerStateSnapshot {
  karma: number;
  virtue: number;
  sanctionCost: number;
  canCheerInMs: number;
}

export class PlayerState {
  private readonly players = new Map<string, PlayerEntry>();
  /** 直近に accrue した時刻 (経過秒からカルマ増分を出す)。未 accrue は null。 */
  private lastAccrueMs: number | null = null;

  private readonly rate = numEnv('PAGUS_KARMA_RATE', 0.5); // 毎秒のカルマ加算量
  private readonly max = numEnv('PAGUS_KARMA_MAX', 100); // カルマ上限
  private readonly inciteCost = numEnv('PAGUS_INCITE_COST', 10); // 扇動コスト
  private readonly sanctionBase = numEnv('PAGUS_SANCTION_COST', 30); // 制裁コスト基準
  private readonly virtueK = numEnv('PAGUS_SANCTION_VIRTUE_K', 1); // 善性による制裁コスト係数
  private readonly cheerInterval = numEnv('PAGUS_CHEER_INTERVAL_MS', 180000); // 応援インターバル
  private readonly cheerVirtue = numEnv('PAGUS_CHEER_VIRTUE', 0.05); // 応援1回の善性上昇

  /** 扇動の固定コスト。 */
  get inciteCostValue(): number {
    return this.inciteCost;
  }

  /** 無ければ {karma:0,virtue:0,lastCheerMs:0} で作成して返す。 */
  get(userId: string): PlayerEntry {
    let e = this.players.get(userId);
    if (!e) {
      e = { karma: 0, virtue: 0, lastCheerMs: 0 };
      this.players.set(userId, e);
    }
    return e;
  }

  /** 全ユーザに経過秒ぶんの rate を足し、max でクランプする。server が 1 秒間隔で呼ぶ。 */
  accrue(now: number): void {
    if (this.lastAccrueMs === null) {
      this.lastAccrueMs = now;
      return;
    }
    const elapsedSec = (now - this.lastAccrueMs) / 1000;
    this.lastAccrueMs = now;
    if (elapsedSec <= 0) return;
    const gain = this.rate * elapsedSec;
    for (const e of this.players.values()) {
      e.karma = Math.min(this.max, e.karma + gain);
    }
  }

  /** いま制裁に必要なカルマ (善性が高いほど重い, §4.4)。 */
  sanctionCost(userId: string): number {
    const e = this.get(userId);
    return this.sanctionBase * (1 + e.virtue * this.virtueK);
  }

  /** カルマが足りれば cost を引いて true、足りなければ false。 */
  spend(userId: string, cost: number): boolean {
    const e = this.get(userId);
    if (e.karma < cost) return false;
    e.karma -= cost;
    return true;
  }

  /** 応援 (§4.5)。インターバルを過ぎていれば lastCheer 更新 + 善性加算して true。 */
  cheer(userId: string, now: number): boolean {
    const e = this.get(userId);
    if (now - e.lastCheerMs < this.cheerInterval) return false;
    e.lastCheerMs = now;
    e.virtue = Math.min(1, e.virtue + this.cheerVirtue);
    return true;
  }

  /** 次に応援できるまでの残りミリ秒 (0 = いま可能)。 */
  canCheerInMs(userId: string, now: number): number {
    const e = this.get(userId);
    return Math.max(0, this.cheerInterval - (now - e.lastCheerMs));
  }

  /** 配信用の状態スナップショット。 */
  snapshot(userId: string, now: number): PlayerStateSnapshot {
    const e = this.get(userId);
    return {
      karma: e.karma,
      virtue: e.virtue,
      sanctionCost: this.sanctionCost(userId),
      canCheerInMs: this.canCheerInMs(userId, now),
    };
  }
}
