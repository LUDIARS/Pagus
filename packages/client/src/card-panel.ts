// イベントカードUI。月1配布されたカードを1枚消費し、server側でガチャ効果を確定する。

import type { WireWorld } from '@pagus/sim';

export interface CardHandlers {
  onDraw(): void;
}

export class CardPanel {
  private eventCards = 0;
  private readonly stateBox = document.createElement('div');
  private readonly drawBtn = document.createElement('button');

  constructor(
    private readonly root: HTMLElement,
    private readonly h: CardHandlers,
  ) {
    this.root.replaceChildren();
    this.root.appendChild(heading('イベントカード'));
    this.stateBox.className = 'ctl-state';
    this.root.appendChild(this.stateBox);

    this.drawBtn.className = 'card-btn';
    this.drawBtn.textContent = 'カードを使う';
    this.drawBtn.addEventListener('click', () => this.h.onDraw());
    this.root.appendChild(this.drawBtn);
    this.renderState();
  }

  setWorld(_world: WireWorld): void {
    // 効果はserverで解決するため、対象選択は持たない。
  }

  setKarma(_karma: number): void {
    // 旧カード互換。イベントカードはカルマを消費しない。
  }

  setInventory(eventCards: number): void {
    this.eventCards = Math.max(0, Math.floor(eventCards));
    this.renderState();
  }

  private renderState(): void {
    this.stateBox.replaceChildren();
    this.stateBox.appendChild(kv('所持', `${this.eventCards}枚`));
    this.drawBtn.disabled = this.eventCards <= 0;
    this.drawBtn.title = this.eventCards > 0 ? 'イベントカードを1枚使う' : 'イベントカードがありません';
  }
}

function heading(text: string): HTMLElement {
  const el = document.createElement('h3');
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
