// 証言パネル (§v1.4-A)。裁判の運命 (fate) 段階だけ中央の判決ボタン下に出す:
// 一言 (任意・30 文字) + 「🗣 有罪の証言」/「🛡 弁護の証言」。1 裁判 1 回 (送信後は無効化)。

import type { WireWorld } from '@pagus/sim';

export type TestifyStance = 'accuse' | 'defend';

export class TestifyPanel {
  private world: WireWorld | null = null;
  private testifyCost = 0;
  /** 証言済みの裁判 incidentId (楽観的に無効化。確定拒否は server の commandRejected)。 */
  private testifiedIncidentId: string | null = null;

  private readonly input = document.createElement('input');
  private readonly accuseBtn = document.createElement('button');
  private readonly defendBtn = document.createElement('button');

  constructor(
    private readonly root: HTMLElement,
    private readonly onTestify: (stance: TestifyStance, text?: string) => void,
  ) {
    this.input.className = 'testify-input';
    this.input.type = 'text';
    this.input.maxLength = 30;
    this.input.placeholder = '証言の一言 (任意)';
    this.accuseBtn.className = 'testify-btn accuse';
    this.defendBtn.className = 'testify-btn defend';
    this.accuseBtn.addEventListener('click', () => this.send('accuse'));
    this.defendBtn.addEventListener('click', () => this.send('defend'));
    this.root.append(this.input, this.accuseBtn, this.defendBtn);
    this.render();
  }

  setWorld(world: WireWorld): void {
    this.world = world;
    this.render();
  }

  setState(testifyCost: number): void {
    this.testifyCost = testifyCost;
    this.render();
  }

  private send(stance: TestifyStance): void {
    const trial = this.world?.trial;
    if (!trial) return;
    const text = this.input.value.trim();
    this.onTestify(stance, text.length > 0 ? text : undefined);
    this.testifiedIncidentId = trial.incidentId;
    this.input.value = '';
    this.render();
  }

  private render(): void {
    const w = this.world;
    const trial = w?.trial ?? null;
    const active = !!w && w.phase === 'ten' && trial?.stage === 'fate';
    this.root.classList.toggle('show', active);
    if (!active || !trial) return;
    const done = this.testifiedIncidentId === trial.incidentId;
    this.accuseBtn.textContent = done ? '🗣 証言済み' : `🗣 有罪の証言 −${this.testifyCost}`;
    this.defendBtn.textContent = done ? '🛡 証言済み' : `🛡 弁護の証言 −${this.testifyCost}`;
    this.accuseBtn.disabled = done;
    this.defendBtn.disabled = done;
    this.input.disabled = done;
  }
}
