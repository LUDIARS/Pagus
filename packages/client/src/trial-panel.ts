// 裁判 (転) の投票パネル。foolish 段階は候補へ、fate 段階は殺す/活かすへ投票する。

import type { WireWorld } from '@pagus/sim';

export class TrialPanel {
  constructor(
    private readonly root: HTMLElement,
    private readonly sendVote: (pick: string) => void,
  ) {}

  update(world: WireWorld): void {
    const trial = world.trial;
    if (!trial || world.phase !== 'ten') {
      this.root.style.display = 'none';
      this.root.replaceChildren();
      return;
    }
    this.root.style.display = 'block';
    this.root.replaceChildren();

    const nameOf = (id: string): string => world.villagers.find((v) => v.id === id)?.name ?? id;

    if (trial.stage === 'foolish') {
      this.root.appendChild(this.title('⚖ 裁判: 最も愚かな行動は？'));
      for (const id of trial.candidates) {
        this.root.appendChild(
          this.button(`${nameOf(id)} (${trial.foolishVotes[id] ?? 0})`, () => this.sendVote(id)),
        );
      }
    } else {
      const defendant = trial.defendant ? nameOf(trial.defendant) : '?';
      this.root.appendChild(this.title(`⚖ 被告「${defendant}」を…`));
      this.root.appendChild(this.button(`殺す (${trial.fateVotes.kill})`, () => this.sendVote('kill'), 'vote-kill'));
      this.root.appendChild(this.button(`活かす (${trial.fateVotes.spare})`, () => this.sendVote('spare'), 'vote-spare'));
      if (trial.verdict) {
        const v = document.createElement('div');
        v.className = 'trial-verdict';
        v.textContent = `判決: ${trial.verdict === 'death' ? '死刑（追放）' : '活かす（強制教育）'}`;
        this.root.appendChild(v);
      }
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
