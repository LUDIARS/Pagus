// 右上の LLM 設定パネル。稼働中のバックエンド構成と villager→backend 割当を表示。
// 見出しクリックで開閉。

import type { LlmInfo, WireWorld } from '@pagus/sim';

export class LlmPanel {
  private info: LlmInfo | null = null;
  private readonly names = new Map<string, string>();
  private open = false;

  constructor(
    private readonly head: HTMLElement,
    private readonly body: HTMLElement,
  ) {
    this.head.addEventListener('click', () => {
      this.open = !this.open;
      this.render();
    });
    this.render();
  }

  setInfo(info: LlmInfo): void {
    this.info = info;
    this.render();
  }

  /** villager id→名前の対応をスナップショットから更新 (割当表示用)。 */
  setNames(world: WireWorld): void {
    for (const v of world.villagers) this.names.set(v.id, v.name);
    if (this.open) this.render();
  }

  private render(): void {
    const strong = new Set(this.info?.strong ?? []);
    this.head.textContent = `🧠 LLM ${this.modeLabel()} ${this.open ? '▾' : '▸'}`;
    this.body.style.display = this.open ? 'block' : 'none';
    if (!this.open) return;

    this.body.replaceChildren();
    if (!this.info || this.info.mode === 'stub') {
      this.body.appendChild(line('決定的 stub (LLM 不使用)', 'muted'));
      return;
    }

    this.body.appendChild(line('バックエンド', 'sub'));
    for (const b of this.info.backends) {
      this.body.appendChild(line(`${strong.has(b.id) ? '★' : '・'}${b.id}: ${b.model}`, 'mono'));
    }
    this.body.appendChild(line('★=裁判/教育で寄せる strong', 'muted'));

    this.body.appendChild(line('どうぶつ→脳', 'sub'));
    for (const [vid, bid] of Object.entries(this.info.assignments)) {
      this.body.appendChild(line(`${this.names.get(vid) ?? vid} → ${bid}`, 'mono'));
    }
  }

  private modeLabel(): string {
    if (!this.info) return '';
    return this.info.mode === 'llm' ? `(${this.info.backends.length}脳)` : '(stub)';
  }
}

function line(text: string, cls: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.className = cls;
  return el;
}
