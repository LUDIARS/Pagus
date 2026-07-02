// 裁判 (転) の投票パネル。foolish 段階は候補へ、fate 段階は殺す/活かすへ投票する。

import type { WireWorld } from '@pagus/sim';
import { villagerDisplayName } from './villager-display.js';

export class TrialPanel {
  constructor(
    private readonly root: HTMLElement,
    private readonly sendVote: (pick: string) => void,
  ) {}

  // foolish 段階 (被告を選ぶ) のみ担当。殺す/活かす (有罪/無罪) は中央ボタンへ一本化。
  update(world: WireWorld): void {
    const trial = world.trial;
    if (!trial || world.phase !== 'ten' || trial.stage !== 'foolish') {
      this.root.style.display = 'none';
      this.root.replaceChildren();
      return;
    }
    this.root.style.display = 'block';
    this.root.replaceChildren();

    const nameOf = (id: string): string => {
      const v = world.villagers.find((item) => item.id === id);
      return v ? villagerDisplayName(world, v) : id;
    };

    this.root.appendChild(this.title('⚖ 裁判: 最も愚かな行動は？'));
    for (const id of trial.candidates) {
      this.root.appendChild(
        this.button(`${nameOf(id)} (${trial.foolishVotes[id] ?? 0})`, () => this.sendVote(id)),
      );
    }
  }

  private title(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'trial-title';
    el.textContent = text;
    return el;
  }

  private button(label: string, onClick: () => void, cls?: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (cls) btn.className = cls;
    btn.addEventListener('click', onClick);
    return btn;
  }
}
