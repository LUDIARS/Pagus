// 演出・協力パネル (§v1.3-D)。観戦者向けの演出/協力 UI:
//   ㉑ ハイライト一覧 / ㉓ 予測アワード (発生日入力) / ㉔ 月間MVP (住民投票) /
//   ㉕ 観客の祈り (ボタン) / ㉙ 共闘レイド (HP バー + 投入) / ㉚ シーズン結果。
// 受理可否の最終判定は server (commandRejected はトーストで既出)。ここは入力を集めて送るだけ。

import type { WireWorld, HighlightCard, SeasonWinner, LeaderboardEntry } from '@pagus/sim';
import { villagerDisplayName } from './villager-display.js';

export interface SpectacleHandlers {
  onPredictDay(dayOfMonth: number): void;
  onVoteMvp(villagerId: string): void;
  onPray(): void;
  onRaidStrike(amount: number): void;
}

export interface SpectaclePanelOptions {
  readOnly?: boolean;
}

const WINNER_LABEL: Record<SeasonWinner, string> = { guide: '善導陣営の勝利', incite: '扇動陣営の勝利', draw: '引き分け' };

export class SpectaclePanel {
  private world: WireWorld | null = null;

  // ㉙ レイド状態 (+ ローカル countdown 用受信時刻)。
  private raidActive = false;
  private raidName = '';
  private raidHp = 0;
  private raidHpMax = 0;
  private raidEndsInMs = 0;
  private raidAt = 0;

  private readonly highlightsBox = document.createElement('div');
  private readonly predictDay = document.createElement('input');
  private readonly mvpSelect = document.createElement('select');
  private readonly mvpState = document.createElement('div');
  private readonly raidBox = document.createElement('div');
  private readonly raidAmount = document.createElement('input');
  private readonly seasonBox = document.createElement('div');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly h: SpectacleHandlers,
    private readonly options: SpectaclePanelOptions = {},
  ) {
    this.root.replaceChildren();
    this.root.appendChild(heading('🎬 演出・協力'));

    // ㉙ 共闘レイド (最上段: 出現中は最優先で見せる)。
    this.root.appendChild(subLabel('共闘レイド'));
    this.raidBox.className = 'spc-raid';
    this.root.appendChild(this.raidBox);
    if (!this.options.readOnly) {
      numField(this.raidAmount, '投入カルマ');
      this.root.appendChild(this.raidAmount);
      this.root.appendChild(this.btn('⚔ 討伐に投じる', 'spc-btn spc-raid-btn', () => {
        const n = parseInt(this.raidAmount.value, 10);
        if (Number.isInteger(n) && n > 0) this.h.onRaidStrike(n);
      }));
    }

    // ㉕ 観客の祈り。
    if (!this.options.readOnly) {
      this.root.appendChild(subLabel('観客の祈り (無料・みんなで揃うと村が癒える)'));
      this.root.appendChild(this.btn('🙏 祈る', 'spc-btn spc-pray', () => this.h.onPray()));
    }

    // ㉓ 予測アワード。
    if (!this.options.readOnly) {
      this.root.appendChild(subLabel('予測アワード (今月の事件発生日を当てる)'));
      numField(this.predictDay, '発生日 (例 14)');
      this.root.appendChild(this.predictDay);
      this.root.appendChild(this.btn('🔮 予測する', 'spc-btn', () => {
        const n = parseInt(this.predictDay.value, 10);
        if (Number.isInteger(n) && n > 0) this.h.onPredictDay(n);
      }));
    }

    // ㉔ 月間MVP。
    this.root.appendChild(subLabel(this.options.readOnly ? '月間MVP' : '月間MVP (今月の主役に投票)'));
    this.mvpSelect.className = 'target-select';
    if (!this.options.readOnly) {
      this.root.appendChild(this.mvpSelect);
      this.root.appendChild(this.btn('🏅 MVP に投票', 'spc-btn', () => {
        const id = this.mvpSelect.value;
        if (id) this.h.onVoteMvp(id);
      }));
    }
    this.mvpState.className = 'muted';
    this.root.appendChild(this.mvpState);

    // ㉚ シーズン結果。
    this.root.appendChild(subLabel('シーズン'));
    this.seasonBox.className = 'ctl-state';
    this.root.appendChild(this.seasonBox);

    // ㉑ ハイライト一覧。
    this.root.appendChild(subLabel('ハイライト (村の名場面)'));
    this.highlightsBox.className = 'spc-highlights';
    this.root.appendChild(this.highlightsBox);

    this.renderRaid();
    this.renderSeason(null);
    this.renderHighlights([]);
    this.timer = setInterval(() => this.renderRaid(), 1000);
  }

  setWorld(world: WireWorld): void {
    this.world = world;
    this.refreshMvpTargets();
  }

  setHighlights(cards: HighlightCard[]): void {
    this.renderHighlights(cards);
  }

  setMvp(_villagerId: string, name: string): void {
    this.mvpState.textContent = `🏅 今月の主役: ${name}`;
  }

  setRaid(active: boolean, villainName: string, hp: number, hpMax: number, endsInMs: number): void {
    this.raidActive = active;
    this.raidName = villainName;
    this.raidHp = hp;
    this.raidHpMax = hpMax;
    this.raidEndsInMs = endsInMs;
    this.raidAt = Date.now();
    this.renderRaid();
  }

  setSeason(num: number, winner: SeasonWinner, leaderboard: LeaderboardEntry[]): void {
    this.renderSeason({ num, winner, leaderboard });
  }

  /** MVP 投票セレクタを生存どうぶつで作り直す。 */
  private refreshMvpTargets(): void {
    const w = this.world;
    if (!w) return;
    const alive = w.villagers.filter((v) => v.alive);
    const prev = this.mvpSelect.value;
    this.mvpSelect.replaceChildren();
    if (alive.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(どうぶつがいません)';
      this.mvpSelect.appendChild(opt);
      return;
    }
    for (const v of alive) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${villagerDisplayName(w, v)} (${v.species})`;
      this.mvpSelect.appendChild(opt);
    }
    if (alive.some((v) => v.id === prev)) this.mvpSelect.value = prev;
  }

  private renderRaid(): void {
    this.raidBox.replaceChildren();
    if (!this.raidActive) {
      this.raidBox.appendChild(hint('レイドは出現していません'));
      return;
    }
    this.raidBox.appendChild(kv('👹 凶賊', this.raidName));
    const pct = this.raidHpMax > 0 ? Math.max(0, Math.round((this.raidHp / this.raidHpMax) * 100)) : 0;
    const bar = document.createElement('div');
    bar.className = 'spc-hp-bar';
    const fill = document.createElement('i');
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    this.raidBox.appendChild(bar);
    this.raidBox.appendChild(kv('❤ HP', `${Math.round(this.raidHp)} / ${this.raidHpMax}`));
    this.raidBox.appendChild(kv('⏳ 残り', `あと ${this.remainSec(this.raidEndsInMs, this.raidAt)}秒`));
  }

  private renderHighlights(cards: HighlightCard[]): void {
    this.highlightsBox.replaceChildren();
    if (cards.length === 0) {
      this.highlightsBox.appendChild(hint('まだハイライトはありません'));
      return;
    }
    let currentMonth = '';
    for (const c of [...cards].sort((a, b) => dateScore(b.date) - dateScore(a.date)).slice(0, 12)) {
      const month = monthLabel(c.date);
      if (month !== currentMonth) {
        currentMonth = month;
        const sep = document.createElement('div');
        sep.className = 'spc-hl-month';
        sep.textContent = month;
        this.highlightsBox.appendChild(sep);
      }
      const row = document.createElement('div');
      row.className = 'spc-hl';
      const head = document.createElement('div');
      head.className = 'spc-hl-head';
      head.textContent = `${c.date} ・ ${c.title}`;
      const body = document.createElement('div');
      body.className = 'spc-hl-body';
      body.textContent = c.summary;
      row.append(head, body);
      this.highlightsBox.appendChild(row);
    }
  }

  private renderSeason(s: { num: number; winner: SeasonWinner; leaderboard: LeaderboardEntry[] } | null): void {
    this.seasonBox.replaceChildren();
    if (!s) {
      this.seasonBox.appendChild(hint('シーズン進行中 (数ゲーム月ごとに勝敗が確定)'));
      return;
    }
    this.seasonBox.appendChild(kv(`🏁 シーズン${s.num}`, WINNER_LABEL[s.winner]));
  }

  /** endsInMs を受信時刻からの経過で割り引いた残り秒 (下限0)。 */
  private remainSec(endsInMs: number, receivedAt: number): number {
    return Math.ceil(Math.max(0, endsInMs - (Date.now() - receivedAt)) / 1000);
  }

  private btn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
}

function numField(input: HTMLInputElement, placeholder: string): void {
  input.type = 'number';
  input.min = '1';
  input.className = 'target-select';
  input.placeholder = placeholder;
}
function heading(text: string): HTMLElement {
  const el = document.createElement('h3');
  el.textContent = text;
  return el;
}
function subLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sub';
  el.textContent = text;
  return el;
}
function hint(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'muted';
  el.textContent = text;
  return el;
}
function kv(label: string, value: string): HTMLElement {
  const r = document.createElement('div');
  r.className = 'kv';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'kv-val';
  v.textContent = value;
  r.append(l, v);
  return r;
}

function dateScore(date: string): number {
  const m = date.match(/(\d+)月(\d+)日/);
  if (!m) return 0;
  return Number(m[1]) * 100 + Number(m[2]);
}

function monthLabel(date: string): string {
  const m = date.match(/(\d+)月/);
  return m ? `${m[1]}月` : '日付なし';
}
