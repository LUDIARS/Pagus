// 状態パネル (§7)。稼働時間 (1秒更新) / ゲーム内日付 / LLM コストを表示する。
// 右上の LLM パネルと同じ流儀で、見出しクリックで開閉する。

import type { SysStatus } from './ws-client.js';

export class StatusPanel {
  private status: SysStatus | null = null;
  private open = false;

  constructor(
    private readonly head: HTMLElement,
    private readonly body: HTMLElement,
  ) {
    this.head.addEventListener('click', () => {
      this.open = !this.open;
      this.render();
    });
    // 稼働時間を 1 秒ごとに更新する (開いている時だけ再描画)。
    setInterval(() => {
      if (this.open) this.render();
    }, 1000);
    this.render();
  }

  setStatus(s: SysStatus): void {
    this.status = s;
    if (this.open) this.render();
  }

  private render(): void {
    this.head.textContent = `📊 状態 ${this.open ? '▾' : '▸'}`;
    this.body.style.display = this.open ? 'block' : 'none';
    if (!this.open) return;

    this.body.replaceChildren();
    const s = this.status;
    if (!s) {
      this.body.appendChild(line('接続待ち…', 'muted'));
      return;
    }

    this.body.appendChild(row('稼働時間', formatUptime(Date.now() - s.startedAt)));
    this.body.appendChild(row('ゲーム内', `${s.gameYear}年 ${s.gameDate}`));
    this.body.appendChild(row('経過ターム', `${s.term} 日目`));

    const cost = s.cost;
    this.body.appendChild(line('LLM コスト', 'sub'));
    this.body.appendChild(row('累計', `$${cost.totalUsd.toFixed(4)}`));
    this.body.appendChild(row('総呼び出し', `${cost.calls} 回`));

    const kinds = Object.entries(cost.byKind).sort((a, b) => b[1].usd - a[1].usd);
    if (kinds.length === 0) {
      this.body.appendChild(line('(まだ LLM 呼び出しなし)', 'muted'));
    } else {
      for (const [kind, k] of kinds) {
        this.body.appendChild(row(`　${kind}`, `${k.calls}回 / $${k.usd.toFixed(4)}`));
      }
    }
  }
}

/** ms を「Xh Ym」へ整形する (§7)。 */
function formatUptime(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function line(text: string, cls: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.className = cls;
  return el;
}

function row(label: string, value: string): HTMLElement {
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
