// 村の歴史ビュー。📜ボタンで開閉するモーダル。日付ごとに節目を時系列で並べる。

import type { ChronicleEntry } from '@pagus/sim';

export class ChronicleView {
  private entries: ChronicleEntry[] = [];
  private open = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly body: HTMLElement,
    openBtn: HTMLElement,
    closeBtn: HTMLElement,
  ) {
    openBtn.addEventListener('click', () => this.toggle(true));
    closeBtn.addEventListener('click', () => this.toggle(false));
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.toggle(false);
    });
  }

  setEntries(entries: ChronicleEntry[]): void {
    this.entries = entries;
    if (this.open) this.render();
  }

  private toggle(open: boolean): void {
    this.open = open;
    this.root.classList.toggle('show', open);
    if (open) this.render();
  }

  private render(): void {
    this.body.replaceChildren();
    if (this.entries.length === 0) {
      this.body.appendChild(div('まだ歴史は刻まれていません。', 'muted'));
      return;
    }
    let lastDate = '';
    for (const e of this.entries) {
      if (e.date !== lastDate) {
        this.body.appendChild(div(e.date, 'hist-date'));
        lastDate = e.date;
      }
      this.body.appendChild(div(e.text, 'hist-line'));
    }
    // 最新 (末尾) が見えるようスクロール。
    this.body.scrollTop = this.body.scrollHeight;
  }
}

function div(text: string, cls: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.className = cls;
  return el;
}
