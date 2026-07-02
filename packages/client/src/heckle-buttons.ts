// 野次ボタン (§v1.4-A)。事件 (承) の進行中だけ中央ステージ下に出す 2 ボタン:
// 「📣 煽る」(被害を増やし和解しにくく) /「🕊 なだめる」(和解しやすく)。
// コストとクールダウンは playerState から表示し、押せない間は無効化する。

import type { WireWorld } from '@pagus/sim';

export type HeckleSideChoice = 'agitate' | 'soothe';

export class HeckleButtons {
  private world: WireWorld | null = null;
  private heckleCost = 0;
  private canHeckleInMs = 0;
  /** 最後に playerState を受けた時刻。残クールダウンの経過を手元で進める。 */
  private stateAtMs = 0;

  private readonly agitateBtn = document.createElement('button');
  private readonly sootheBtn = document.createElement('button');

  constructor(
    private readonly root: HTMLElement,
    private readonly onHeckle: (side: HeckleSideChoice) => void,
  ) {
    this.agitateBtn.className = 'heckle-btn agitate';
    this.sootheBtn.className = 'heckle-btn soothe';
    this.agitateBtn.addEventListener('click', () => this.onHeckle('agitate'));
    this.sootheBtn.addEventListener('click', () => this.onHeckle('soothe'));
    this.root.append(this.agitateBtn, this.sootheBtn);
    // クールダウンの残りを毎秒詰める (state 再送を待たずに表示/活性を進める)。
    setInterval(() => this.render(), 1000);
    this.render();
  }

  setWorld(world: WireWorld): void {
    this.world = world;
    this.render();
  }

  setState(heckleCost: number, canHeckleInMs: number): void {
    this.heckleCost = heckleCost;
    this.canHeckleInMs = canHeckleInMs;
    this.stateAtMs = Date.now();
    this.render();
  }

  /** 手元で経過を進めた残クールダウン ms。 */
  private cooldownLeft(): number {
    return Math.max(0, this.canHeckleInMs - (Date.now() - this.stateAtMs));
  }

  private render(): void {
    const w = this.world;
    const active = !!w && w.phase === 'sho' && w.incident !== null;
    this.root.classList.toggle('show', active);
    if (!active) return;
    const cd = this.cooldownLeft();
    const suffix = cd > 0 ? ` あと${Math.ceil(cd / 1000)}s` : ` −${this.heckleCost}`;
    this.agitateBtn.textContent = `📣 煽る${suffix}`;
    this.sootheBtn.textContent = `🕊 なだめる${suffix}`;
    this.agitateBtn.disabled = cd > 0;
    this.sootheBtn.disabled = cd > 0;
  }
}
