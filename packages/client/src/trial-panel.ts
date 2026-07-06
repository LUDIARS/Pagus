// 裁判 (転) の投票パネル。foolish 段階は候補へ、fate 段階は殺す/活かすへ投票する。

import type { WireWorld } from '@pagus/sim';
import { villagerDisplayName } from './villager-display.js';

export class TrialPanel {
  private verdictCooldownUntil = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly sendVote: (pick: string) => void,
  ) {}

  update(world: WireWorld): void {
    const trial = world.trial;
    if (!trial || world.phase !== 'ten' || trial.stage === 'decided') {
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

    if (trial.stage === 'foolish') {
      this.root.appendChild(this.title('⚖ 裁判: 誰を裁くか'));
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.textContent = '疑わしい住民を選ぶ。住民たちの発言が一巡すると量刑へ進む。';
      this.root.appendChild(hint);
      for (const id of trial.candidates) {
        this.root.appendChild(
          this.button(`${nameOf(id)} (${trial.foolishVotes[id] ?? 0})`, () => this.sendVote(id)),
        );
      }
      return;
    }

    const defendant = trial.defendant ? nameOf(trial.defendant) : '未定';
    this.root.appendChild(this.title(`⚖ 裁判: ${defendant} をどう裁くか`));
    const tally = document.createElement('div');
    tally.className = 'trial-tally';
    tally.textContent = `住民票: 死刑 ${trial.fateVotes.kill} / 教育 ${trial.fateVotes.spare}`;
    this.root.appendChild(tally);
    const buttons = document.createElement('div');
    buttons.className = 'trial-verdict-row';
    const cooling = Date.now() < this.verdictCooldownUntil;
    const kill = this.button('死刑', () => this.voteVerdict('kill'), 'vote-kill');
    const spare = this.button('教育', () => this.voteVerdict('spare'), 'vote-spare');
    kill.disabled = cooling;
    spare.disabled = cooling;
    buttons.append(kill, spare);
    this.root.appendChild(buttons);
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = '発言後、住民が3言ほど反応して裁判は結審する。';
    this.root.appendChild(note);
  }

  private voteVerdict(pick: 'kill' | 'spare'): void {
    if (Date.now() < this.verdictCooldownUntil) return;
    this.verdictCooldownUntil = Date.now() + 3500;
    this.sendVote(pick);
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
