// カードパネル (§v1.3-A)。カルマで切る一発介入カード 5 種の UI。
// 対象/対象2/種別/テキストの必要分を選ばせ、コストとクールダウンを表示して送信する。
// 受理可否の最終判定は server (commandRejected はトーストで既出)。ここでは optimistic に
// クールダウンを表示し、カルマ不足のカードは無効化する。

import type { WireWorld, CardName } from '@pagus/sim';

/** カード送信の引数 (card 別に必要分だけ詰める)。 */
export interface CardArgs {
  targetId?: string;
  targetId2?: string;
  kind?: string;
  text?: string;
}

export interface CardHandlers {
  onCard(card: CardName, args: CardArgs): void;
}

/** カード 1 種の定義 (UI 構築用)。 */
interface CardDef {
  card: CardName;
  label: string;
  cost: number;
}

/** card 別コスト (env 既定と一致, 表示のみ。実コストは server が権威)。 */
const CARD_DEFS: CardDef[] = [
  { card: 'disaster', label: '🌪 天災', cost: 40 },
  { card: 'spiritAway', label: '🌫 神隠し', cost: 35 },
  { card: 'swap', label: '🔄 入れ替え', cost: 30 },
  { card: 'awaken', label: '✨ 覚醒', cost: 25 },
  { card: 'falseProphecy', label: '🔮 偽予言', cost: 20 },
];

export class CardPanel {
  private world: WireWorld | null = null;
  private karma = 0;
  /** optimistic なクールダウン終了時刻 (ms)。0 = 使用可。 */
  private cooldownUntil = 0;
  private cdTimer: ReturnType<typeof setInterval> | null = null;

  private readonly stateBox = document.createElement('div');
  /** card → その card のボタン (カルマ/クールダウンで無効化する)。 */
  private readonly buttons = new Map<CardName, HTMLButtonElement>();
  /** 対象セレクタ群 (setWorld で作り直す)。 */
  private readonly selects: HTMLSelectElement[] = [];
  private readonly disasterKind = document.createElement('select');
  private readonly swapA = document.createElement('select');
  private readonly swapB = document.createElement('select');
  private readonly spiritTarget = document.createElement('select');
  private readonly awakenTarget = document.createElement('select');
  private readonly prophecyText = document.createElement('input');

  constructor(
    private readonly root: HTMLElement,
    private readonly h: CardHandlers,
    private readonly cooldownMs = 60000,
  ) {
    this.root.replaceChildren();
    this.root.appendChild(heading('🃏 カード'));
    this.stateBox.className = 'ctl-state';
    this.root.appendChild(this.stateBox);

    // 天災: 種別 select + ボタン。
    this.root.appendChild(subLabel('天災の種別'));
    this.disasterKind.className = 'target-select';
    for (const [v, t] of [['drought', '干ばつ'], ['storm', '嵐'], ['plague', '疫病']] as const) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = t;
      this.disasterKind.appendChild(opt);
    }
    this.root.appendChild(this.disasterKind);
    this.root.appendChild(this.cardButton('disaster', () => ({ kind: this.disasterKind.value })));
    // (各 collectArgs は exactOptionalPropertyTypes に合わせ、値があるキーだけ詰める。)

    // 神隠し: 対象 1 体。
    this.root.appendChild(subLabel('神隠しの対象'));
    this.spiritTarget.className = 'target-select';
    this.selects.push(this.spiritTarget);
    this.root.appendChild(this.spiritTarget);
    this.root.appendChild(this.cardButton('spiritAway', () => pick({ targetId: this.spiritTarget.value })));

    // 入れ替え: 2 体。
    this.root.appendChild(subLabel('入れ替え (2体)'));
    this.swapA.className = 'target-select';
    this.swapB.className = 'target-select';
    this.selects.push(this.swapA, this.swapB);
    this.root.appendChild(this.swapA);
    this.root.appendChild(this.swapB);
    this.root.appendChild(this.cardButton('swap', () => pick({ targetId: this.swapA.value, targetId2: this.swapB.value })));

    // 覚醒: 対象 1 体。
    this.root.appendChild(subLabel('覚醒の対象'));
    this.awakenTarget.className = 'target-select';
    this.selects.push(this.awakenTarget);
    this.root.appendChild(this.awakenTarget);
    this.root.appendChild(this.cardButton('awaken', () => pick({ targetId: this.awakenTarget.value })));

    // 偽予言: 任意テキスト。
    this.root.appendChild(subLabel('偽予言 (文面は任意)'));
    this.prophecyText.className = 'target-select';
    this.prophecyText.type = 'text';
    this.prophecyText.placeholder = '不吉な予言…(空欄可)';
    this.root.appendChild(this.prophecyText);
    this.root.appendChild(this.cardButton('falseProphecy', () => {
      const text = this.prophecyText.value.trim();
      return text.length > 0 ? { text } : {};
    }));

    this.root.appendChild(hint('各カードは 1 回使うとクールダウン。カルマ不足は無効。効果は server が確定'));
    this.renderState();
  }

  setWorld(world: WireWorld): void {
    this.world = world;
    this.refreshTargets();
  }

  setKarma(karma: number): void {
    this.karma = karma;
    this.renderState();
  }

  /** 全対象セレクタを生存どうぶつで作り直す。 */
  private refreshTargets(): void {
    const w = this.world;
    if (!w) return;
    const alive = w.villagers.filter((v) => v.alive);
    for (const sel of this.selects) {
      const prev = sel.value;
      sel.replaceChildren();
      if (alive.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(どうぶつがいません)';
        sel.appendChild(opt);
        continue;
      }
      for (const v of alive) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = `${v.name} (${v.species})`;
        sel.appendChild(opt);
      }
      // 退場していなければ前回選択を保つ。
      if (alive.some((v) => v.id === prev)) sel.value = prev;
    }
  }

  private renderState(): void {
    this.stateBox.replaceChildren();
    this.stateBox.appendChild(kv('💠 カルマ', this.karma.toFixed(1)));
    const cd = Math.max(0, this.cooldownUntil - Date.now());
    this.stateBox.appendChild(kv('🃏 クールダウン', cd <= 0 ? 'いま可能' : `あと ${Math.ceil(cd / 1000)}秒`));
    // カルマ/クールダウンでボタンの可否を更新し、不可の理由を tooltip に出す (§E)。
    const onCooldown = cd > 0;
    for (const def of CARD_DEFS) {
      const btn = this.buttons.get(def.card);
      if (!btn) continue;
      const insufficient = this.karma < def.cost;
      btn.disabled = onCooldown || insufficient;
      btn.title = onCooldown
        ? `クールダウン中 (あと${Math.ceil(cd / 1000)}秒)`
        : insufficient
          ? `カルマ不足 (必要 ${def.cost} / 所持 ${this.karma.toFixed(0)})`
          : `コスト ${def.cost}`;
    }
  }

  private cardButton(card: CardName, collectArgs: () => CardArgs): HTMLButtonElement {
    const def = CARD_DEFS.find((d) => d.card === card)!;
    const btn = document.createElement('button');
    btn.className = 'card-btn';
    btn.textContent = `${def.label} (${def.cost})`;
    btn.addEventListener('click', () => {
      this.h.onCard(card, collectArgs());
      this.startCooldown();
    });
    this.buttons.set(card, btn);
    return btn;
  }

  /** optimistic にクールダウンを開始し、1 秒ごとに表示を更新する。 */
  private startCooldown(): void {
    this.cooldownUntil = Date.now() + this.cooldownMs;
    if (this.cdTimer) clearInterval(this.cdTimer);
    this.cdTimer = setInterval(() => {
      this.renderState();
      if (Date.now() >= this.cooldownUntil && this.cdTimer) {
        clearInterval(this.cdTimer);
        this.cdTimer = null;
      }
    }, 1000);
    this.renderState();
  }
}

/** 空文字でない値だけを残した CardArgs を作る (exactOptionalPropertyTypes 対応)。 */
function pick(src: { targetId?: string; targetId2?: string }): CardArgs {
  const out: CardArgs = {};
  if (src.targetId) out.targetId = src.targetId;
  if (src.targetId2) out.targetId2 = src.targetId2;
  return out;
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
