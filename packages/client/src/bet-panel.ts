// 裁判ベット UI (§3)。裁判の運命 (fate) 段階で「死刑/教育」に金額を賭ける。
// プール (death/educate 総額) と自分の賭けを表示し、betState を受けて描画する。

import type { WireWorld } from '@pagus/sim';
import type { BetStateView } from './ws-client.js';

export class BetPanel {
  private state: BetStateView | null = null;
  private visible = false;

  private readonly amountInput = document.createElement('input');
  private readonly poolBox = document.createElement('div');
  private readonly yourBox = document.createElement('div');

  constructor(
    private readonly root: HTMLElement,
    private readonly sendBet: (pick: 'death' | 'educate', amount: number) => void,
  ) {
    this.root.style.display = 'none';
    this.root.replaceChildren();

    const head = document.createElement('h3');
    head.textContent = '🎲 裁判ベット';
    this.root.appendChild(head);

    this.poolBox.className = 'bet-pool';
    this.root.appendChild(this.poolBox);
    this.yourBox.className = 'bet-your';
    this.root.appendChild(this.yourBox);

    const amountRow = document.createElement('div');
    amountRow.className = 'bet-amount-row';
    const label = document.createElement('span');
    label.className = 'sub';
    label.textContent = '賭け金 (カルマ)';
    this.amountInput.type = 'number';
    this.amountInput.min = '1';
    this.amountInput.step = '1';
    this.amountInput.value = '5';
    this.amountInput.className = 'bet-amount';
    amountRow.append(label, this.amountInput);
    this.root.appendChild(amountRow);

    const btns = document.createElement('div');
    btns.className = 'bet-btns';
    btns.append(
      this.betButton('💀 死刑にベット', 'death', 'bet-death'),
      this.betButton('📚 教育にベット', 'educate', 'bet-educate'),
    );
    this.root.appendChild(btns);
    this.root.appendChild(hint('運命段階のみ。増額のみ可 (別の選択肢への乗り換え不可)。決済は判決確定時。'));

    this.render();
  }

  /** 運命 (fate) 段階の裁判のときだけ表示する。 */
  update(world: WireWorld): void {
    const trial = world.trial;
    this.visible = world.phase === 'ten' && !!trial && trial.stage === 'fate';
    this.root.style.display = this.visible ? 'block' : 'none';
  }

  setBetState(s: BetStateView): void {
    this.state = s;
    this.render();
  }

  private betButton(text: string, pick: 'death' | 'educate', cls: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.className = cls;
    btn.addEventListener('click', () => {
      const amount = Math.floor(Number(this.amountInput.value));
      if (!Number.isFinite(amount) || amount < 1) return;
      this.sendBet(pick, amount);
    });
    return btn;
  }

  private render(): void {
    const s = this.state;
    const death = s?.pool.death ?? 0;
    const educate = s?.pool.educate ?? 0;
    this.poolBox.replaceChildren(
      kv('💀 死刑プール', `${death}`),
      kv('📚 教育プール', `${educate}`),
    );
    this.yourBox.replaceChildren();
    if (s?.yourBet) {
      const side = s.yourBet.pick === 'death' ? '死刑' : '教育';
      this.yourBox.appendChild(kv('🪙 あなたの賭け', `${side} に ${s.yourBet.amount}`));
    } else {
      this.yourBox.appendChild(hint('まだ賭けていません'));
    }
  }
}

function hint(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'muted';
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
