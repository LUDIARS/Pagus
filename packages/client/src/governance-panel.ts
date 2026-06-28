// 政治パネル (§v1.3-C)。統治の操作 UI:
//   ⑥ 村長選挙 (投票先 userId + 現村長表示) / ⑦ 法案 (提案 + 賛否投票) /
//   ⑧ 革命 (蜂起中に扇動/鎮圧) / ⑨ 戒厳令 (freeze/surge) / ⑩ 村基金 (残高表示)。
// 受理可否の最終判定は server (commandRejected はトーストで既出)。ここでは入力を集めて送るだけ。

import type { LawView, MartialMode } from '@pagus/sim';

export interface GovernanceHandlers {
  onVoteMayor(target: string): void;
  onProposeLaw(text: string): void;
  onVoteLaw(lawId: string, approve: boolean): void;
  onRevolt(side: 'incite' | 'suppress'): void;
  onMartial(mode: MartialMode): void;
}

export class GovernancePanel {
  // 受信状態 + ローカル countdown 用の受信時刻。
  private mayorId: string | null = null;
  private mayorEndsInMs = 0;
  private mayorAt = 0;
  private laws: LawView[] = [];
  private lawsAt = 0;
  private revoltActive = false;
  private inciteTotal = 0;
  private suppressTotal = 0;
  private revoltEndsInMs = 0;
  private revoltAt = 0;
  private martialMode: MartialMode | null = null;
  private fundAmount = 0;
  private fundThreshold = 100;

  private readonly mayorBox = document.createElement('div');
  private readonly voteTarget = document.createElement('input');
  private readonly lawText = document.createElement('input');
  private readonly lawsBox = document.createElement('div');
  private readonly revoltBox = document.createElement('div');
  private readonly martialBox = document.createElement('div');
  private readonly fundBox = document.createElement('div');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly myUserId: string,
    private readonly h: GovernanceHandlers,
  ) {
    this.root.replaceChildren();
    this.root.appendChild(heading('🏛 政治'));

    // ⑥ 村長選挙。
    this.root.appendChild(subLabel('村長'));
    this.mayorBox.className = 'ctl-state';
    this.root.appendChild(this.mayorBox);
    textField(this.voteTarget, '投票先 userId');
    this.root.appendChild(this.voteTarget);
    const mayorBtns = document.createElement('div');
    mayorBtns.className = 'ctl-btns';
    mayorBtns.append(
      this.btn('🗳 投票', 'gov-btn', () => {
        const t = this.voteTarget.value.trim();
        if (t) this.h.onVoteMayor(t);
      }),
      this.btn('🙋 自分に', 'gov-btn', () => this.h.onVoteMayor(this.myUserId)),
    );
    this.root.appendChild(mayorBtns);

    // ⑦ 法案。
    this.root.appendChild(subLabel('法案 (供託カルマ。可決で村の掟に)'));
    textField(this.lawText, '法案の文 (1〜40字)');
    this.root.appendChild(this.lawText);
    this.root.appendChild(this.btn('📜 法案を提案', 'gov-btn', () => {
      const t = this.lawText.value.trim();
      if (t) {
        this.h.onProposeLaw(t);
        this.lawText.value = '';
      }
    }));
    this.lawsBox.className = 'gov-laws';
    this.root.appendChild(this.lawsBox);

    // ⑧ 革命。
    this.root.appendChild(subLabel('革命 (蜂起中のみ)'));
    this.revoltBox.className = 'ctl-state';
    this.root.appendChild(this.revoltBox);
    const revoltBtns = document.createElement('div');
    revoltBtns.className = 'ctl-btns';
    revoltBtns.append(
      this.btn('🔥 扇動', 'gov-btn gov-incite', () => this.h.onRevolt('incite')),
      this.btn('🛡 鎮圧', 'gov-btn gov-suppress', () => this.h.onRevolt('suppress')),
    );
    this.root.appendChild(revoltBtns);

    // ⑨ 戒厳令。
    this.root.appendChild(subLabel('戒厳令 (集約カルマで発動)'));
    this.martialBox.className = 'ctl-state';
    this.root.appendChild(this.martialBox);
    const martialBtns = document.createElement('div');
    martialBtns.className = 'ctl-btns';
    martialBtns.append(
      this.btn('❄ 凍結', 'gov-btn', () => this.h.onMartial('freeze')),
      this.btn('⚡ 多発', 'gov-btn', () => this.h.onMartial('surge')),
    );
    this.root.appendChild(martialBtns);

    // ⑩ 村基金。
    this.root.appendChild(subLabel('村基金 (税で貯まり閾値で村イベント)'));
    this.fundBox.className = 'ctl-state';
    this.root.appendChild(this.fundBox);

    this.renderAll();
    this.timer = setInterval(() => this.renderTimed(), 1000);
  }

  setMayor(userId: string | null, endsInMs: number): void {
    this.mayorId = userId;
    this.mayorEndsInMs = endsInMs;
    this.mayorAt = Date.now();
    this.renderMayor();
  }

  setLaws(items: LawView[]): void {
    this.laws = items;
    this.lawsAt = Date.now();
    this.renderLaws();
  }

  setRevolt(active: boolean, incite: number, suppress: number, endsInMs: number): void {
    this.revoltActive = active;
    this.inciteTotal = incite;
    this.suppressTotal = suppress;
    this.revoltEndsInMs = endsInMs;
    this.revoltAt = Date.now();
    this.renderRevolt();
  }

  setMartial(mode: MartialMode | null): void {
    this.martialMode = mode;
    this.renderMartial();
  }

  setFund(amount: number, threshold: number): void {
    this.fundAmount = amount;
    this.fundThreshold = threshold;
    this.renderFund();
  }

  private renderAll(): void {
    this.renderMayor();
    this.renderLaws();
    this.renderRevolt();
    this.renderMartial();
    this.renderFund();
  }

  /** ms 締切のあるもの (村長/法案/革命) の残り表示を更新する。 */
  private renderTimed(): void {
    this.renderMayor();
    this.renderLaws();
    this.renderRevolt();
  }

  private renderMayor(): void {
    this.mayorBox.replaceChildren();
    const who = this.mayorId ? (this.mayorId === this.myUserId ? 'あなた' : shortId(this.mayorId)) : '(空位)';
    this.mayorBox.appendChild(kv('👑 村長', who));
    this.mayorBox.appendChild(kv('⏳ 任期', `あと ${this.remainSec(this.mayorEndsInMs, this.mayorAt)}秒`));
  }

  private renderLaws(): void {
    this.lawsBox.replaceChildren();
    if (this.laws.length === 0) {
      this.lawsBox.appendChild(hint('投票中の法案はありません'));
      return;
    }
    for (const law of this.laws) {
      const row = document.createElement('div');
      row.className = 'gov-law';
      const t = document.createElement('div');
      t.className = 'gov-law-text';
      t.textContent = `「${law.text}」`;
      row.appendChild(t);
      const meta = document.createElement('div');
      meta.className = 'gov-law-meta';
      meta.textContent = `賛成${law.yes} / 反対${law.no} ・ あと ${this.remainSec(law.endsInMs, this.lawsAt)}秒`;
      row.appendChild(meta);
      const btns = document.createElement('div');
      btns.className = 'ctl-btns';
      btns.append(
        this.btn('賛成', 'gov-btn gov-yes', () => this.h.onVoteLaw(law.id, true)),
        this.btn('反対', 'gov-btn gov-no', () => this.h.onVoteLaw(law.id, false)),
      );
      row.appendChild(btns);
      this.lawsBox.appendChild(row);
    }
  }

  private renderRevolt(): void {
    this.revoltBox.replaceChildren();
    if (!this.revoltActive) {
      this.revoltBox.appendChild(hint('蜂起していません (悪辣が高まると始まる)'));
      return;
    }
    this.revoltBox.appendChild(kv('🔥 扇動', String(this.inciteTotal)));
    this.revoltBox.appendChild(kv('🛡 鎮圧', String(this.suppressTotal)));
    this.revoltBox.appendChild(kv('⏳ 決着', `あと ${this.remainSec(this.revoltEndsInMs, this.revoltAt)}秒`));
  }

  private renderMartial(): void {
    this.martialBox.replaceChildren();
    const label = this.martialMode === 'freeze' ? '❄ 凍結 発動中' : this.martialMode === 'surge' ? '⚡ 多発 発動中' : '(なし)';
    this.martialBox.appendChild(kv('🛡 戒厳令', label));
  }

  private renderFund(): void {
    this.fundBox.replaceChildren();
    this.fundBox.appendChild(kv('🏦 村基金', `${Math.round(this.fundAmount)} / ${this.fundThreshold}`));
  }

  /** endsInMs を受信時刻からの経過で割り引いた残り秒 (下限0)。 */
  private remainSec(endsInMs: number, receivedAt: number): number {
    return Math.ceil(Math.max(0, endsInMs - (Date.now() - receivedAt)) / 1000);
  }

  private btn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
}

function textField(input: HTMLInputElement, placeholder: string): void {
  input.type = 'text';
  input.className = 'target-select';
  input.placeholder = placeholder;
}
function shortId(id: string): string {
  return id.length > 6 ? `${id.slice(0, 6)}…` : id;
}
function heading(text: string): HTMLElement {
  const el = document.createElement('h3');
  el.textContent = text;
  return el;
}
function subLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sub';
  el.textContent = text;
  return el;
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
