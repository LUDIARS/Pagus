// 中央ちょい下に重ねる、大きめフォントのテキストログ。
// 最新を下に積み、古いものから消す。村/裁判の進行が一番目に入る位置。

import type { Phase } from '@pagus/sim';

const MAX = 9;

export class LogOverlay {
  private currentDate = '';

  constructor(private readonly root: HTMLElement) {}

  setDate(date: string): void {
    if (date === this.currentDate) return;
    this.currentDate = date;
    this.root.dataset.date = date;
    this.root.replaceChildren();
    const div = document.createElement('div');
    div.className = 'ov-line log-kisho';
    div.textContent = `── ${date} ──`;
    this.root.appendChild(div);
  }

  add(phase: Phase, text: string): void {
    const div = document.createElement('div');
    div.className = `ov-line log-${phase}`;
    div.textContent = text;
    this.root.appendChild(div);
    while (this.root.childElementCount > MAX) this.root.firstElementChild?.remove();
    this.root.scrollTop = this.root.scrollHeight;
  }
}
