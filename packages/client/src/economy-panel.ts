// 経済パネル (§v1.3-B)。カルマ経済の操作 UI:
//   ③ 推し保険 (対象 + 保険料) / ⑤ 闇市 (復活 + カード購入) /
//   ② オークション (現ロット表示 + 入札)。
// 人から人への送金 (旧 ①) と銀行/預金 (旧 ④) は廃止。受理可否の最終判定は server
// (commandRejected はトーストで既出)。ここでは入力を集めて送るだけ。

import type { WireWorld, MarketItem, AuctionLotView } from '@pagus/sim';
import { villagerDisplayName } from './villager-display.js';

export interface EconomyHandlers {
  onInsure(targetId: string, premium: number): void;
  onBuyMarket(item: MarketItem, args: { targetId?: string; targetId2?: string; kind?: string }): void;
  onBid(lotId: string, amount: number): void;
}

export class EconomyPanel {
  private world: WireWorld | null = null;
  private karma = 0;
  /** 直近に受け取ったオークションロット (現アクティブ 1 件)。 */
  private lot: AuctionLotView | null = null;
  /** lot を受け取った時刻 (countdown のローカル計算用)。 */
  private lotReceivedAt = 0;
  private auctionTimer: ReturnType<typeof setInterval> | null = null;

  private readonly stateBox = document.createElement('div');
  /** 生存どうぶつで作り直す対象セレクタ群。 */
  private readonly selects: HTMLSelectElement[] = [];
  private readonly insureTarget = document.createElement('select');
  private readonly insurePremium = document.createElement('input');
  private readonly mktDisasterKind = document.createElement('select');
  private readonly mktSwapA = document.createElement('select');
  private readonly mktSwapB = document.createElement('select');
  private readonly mktAwakenTarget = document.createElement('select');
  private readonly auctionBox = document.createElement('div');
  private readonly bidAmt = document.createElement('input');

  constructor(
    private readonly root: HTMLElement,
    private readonly h: EconomyHandlers,
  ) {
    this.root.replaceChildren();
    this.root.appendChild(heading('💰 経済'));
    this.stateBox.className = 'ctl-state';
    this.root.appendChild(this.stateBox);

    // ③ 推し保険。
    this.root.appendChild(subLabel('推し保険 (対象が期間内に死ねば払戻)'));
    this.insureTarget.className = 'target-select';
    this.selects.push(this.insureTarget);
    this.root.appendChild(this.insureTarget);
    numField(this.insurePremium, '保険料');
    this.root.appendChild(this.insurePremium);
    this.root.appendChild(this.actionBtn('🛡 保険を掛ける', 'eco-insure', () => {
      const t = this.insureTarget.value;
      const p = intVal(this.insurePremium);
      if (t && p > 0) this.h.onInsure(t, p);
    }));

    // ⑤ 闇市。
    this.root.appendChild(subLabel('闇市 (プレミアム価格)'));
    this.root.appendChild(this.actionBtn('🛒 死者を復活 (revive)', 'eco-revive', () => this.h.onBuyMarket('revive', {})));
    this.mktDisasterKind.className = 'target-select';
    for (const [v, t] of [['drought', '干ばつ'], ['storm', '嵐'], ['plague', '疫病']] as const) {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = t; this.mktDisasterKind.appendChild(opt);
    }
    this.root.appendChild(this.mktDisasterKind);
    this.root.appendChild(this.actionBtn('🌪 天災を買う', 'eco-mkt-disaster', () => this.h.onBuyMarket('card_disaster', { kind: this.mktDisasterKind.value })));
    this.mktSwapA.className = 'target-select';
    this.mktSwapB.className = 'target-select';
    this.mktAwakenTarget.className = 'target-select';
    this.selects.push(this.mktSwapA, this.mktSwapB, this.mktAwakenTarget);
    this.root.appendChild(this.mktSwapA);
    this.root.appendChild(this.mktSwapB);
    this.root.appendChild(this.actionBtn('🔄 入れ替えを買う', 'eco-mkt-swap', () => this.h.onBuyMarket('card_swap', { targetId: this.mktSwapA.value, targetId2: this.mktSwapB.value })));
    this.root.appendChild(this.mktAwakenTarget);
    this.root.appendChild(this.actionBtn('✨ 覚醒を買う', 'eco-mkt-awaken', () => this.h.onBuyMarket('card_awaken', { targetId: this.mktAwakenTarget.value })));
    this.root.appendChild(this.actionBtn('🔮 偽予言を買う', 'eco-mkt-prophecy', () => this.h.onBuyMarket('card_prophecy', {})));

    // ② オークション。
    this.root.appendChild(subLabel('オークション (現ロットに入札)'));
    this.auctionBox.className = 'eco-auction';
    this.root.appendChild(this.auctionBox);
    numField(this.bidAmt, '入札額');
    this.root.appendChild(this.bidAmt);
    this.root.appendChild(this.actionBtn('🔨 入札', 'eco-bid', () => {
      const lot = this.lot;
      const amt = intVal(this.bidAmt);
      if (lot && amt > 0) this.h.onBid(lot.id, amt);
    }));

    this.renderState();
    this.renderAuction();
  }

  setWorld(world: WireWorld): void {
    this.world = world;
    this.refreshTargets();
  }

  setState(karma: number): void {
    this.karma = karma;
    this.renderState();
  }

  setAuction(lots: AuctionLotView[]): void {
    this.lot = lots[0] ?? null;
    this.lotReceivedAt = Date.now();
    this.renderAuction();
    // 締切までの残り表示を 1 秒ごとに更新する。
    if (!this.auctionTimer) this.auctionTimer = setInterval(() => this.renderAuction(), 1000);
  }

  private refreshTargets(): void {
    const w = this.world;
    if (!w) return;
    const alive = w.villagers.filter((v) => v.alive);
    for (const sel of this.selects) {
      const prev = sel.value;
      sel.replaceChildren();
      if (alive.length === 0) {
        const opt = document.createElement('option');
        opt.value = ''; opt.textContent = '(どうぶつがいません)';
        sel.appendChild(opt);
        continue;
      }
      for (const v of alive) {
        const opt = document.createElement('option');
        opt.value = v.id; opt.textContent = `${villagerDisplayName(w, v)} (${v.species})`;
        sel.appendChild(opt);
      }
      if (alive.some((v) => v.id === prev)) sel.value = prev;
    }
  }

  private renderState(): void {
    this.stateBox.replaceChildren();
    this.stateBox.appendChild(kv('💠 カルマ', this.karma.toFixed(1)));
  }

  private renderAuction(): void {
    this.auctionBox.replaceChildren();
    const lot = this.lot;
    if (!lot) {
      this.auctionBox.appendChild(hint('出品待ち…'));
      return;
    }
    const remainMs = Math.max(0, lot.endsInMs - (Date.now() - this.lotReceivedAt));
    this.auctionBox.appendChild(kv('🎁 出品', lot.title));
    this.auctionBox.appendChild(kv('💰 最高額', lot.highBid > 0 ? `${lot.highBid} (${shortId(lot.highUserId)})` : '入札なし'));
    this.auctionBox.appendChild(kv('⏳ 締切', `あと ${Math.ceil(remainMs / 1000)}秒`));
  }

  private actionBtn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = `eco-btn ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }
}

function intVal(input: HTMLInputElement): number {
  const n = Number(input.value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
function numField(input: HTMLInputElement, placeholder: string): void {
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.className = 'target-select';
  input.placeholder = placeholder;
}
function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 6 ? `${id.slice(0, 6)}…` : id;
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
