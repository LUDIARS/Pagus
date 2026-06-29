// 政治パネル (§v1.3-C + §17)。統治の操作 UI:
//   村長 (§17 村人が選挙で就任: 現村長/任期/匿名世論調査表示 + リコール請求) /
//   ⑦ 法案 (提案 + 賛否投票) / ⑧ 革命 (蜂起中に扇動/鎮圧) / ⑨ 戒厳令 / ⑩ 村基金。
// 村長/世論は snapshot (WireWorld) から、それ以外は専用メッセージから受ける。
// 受理可否の最終判定は server (commandRejected はトーストで既出)。

import type { LawView, MartialMode, WireWorld } from '@pagus/sim';

export interface GovernanceHandlers {
  /** 村長リコールを請求する (§17)。 */
  onRecallMayor(): void;
  onProposeLaw(text: string): void;
  onVoteLaw(lawId: string, approve: boolean): void;
  onRevolt(side: 'incite' | 'suppress'): void;
  onMartial(mode: MartialMode): void;
}

export class GovernancePanel {
  // 受信状態 + ローカル countdown 用の受信時刻。
  private world: WireWorld | null = null;
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
  private readonly pollBox = document.createElement('div');
  private readonly lawText = document.createElement('input');
  private readonly lawsBox = document.createElement('div');
  private readonly revoltBox = document.createElement('div');
  private readonly martialBox = document.createElement('div');
  private readonly fundBox = document.createElement('div');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly h: GovernanceHandlers,
  ) {
    this.root.replaceChildren();
    this.root.appendChild(heading('🏛 政治'));

    // 村長 (§17): 村人が選挙で就任。現村長/任期 + 匿名世論調査 + リコール。
    this.root.appendChild(subLabel('村長 (村人が選挙で就任)'));
    this.mayorBox.className = 'ctl-state';
    this.root.appendChild(this.mayorBox);
    this.pollBox.className = 'gov-poll';
    this.root.appendChild(this.pollBox);
    this.root.appendChild(this.btn('🪧 リコール請求', 'gov-btn gov-recall', () => this.h.onRecallMayor()));
    this.root.appendChild(hint('成功率は支持率と過去の事件で決まる。請願にカルマがかかる。'));

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

  /** snapshot から村長/世論 (§17) を反映する。 */
  setWorld(world: WireWorld): void {
    this.world = world;
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

  /** ms 締切のあるもの (法案/革命) の残り表示を更新する。村長は term ベースで snapshot 時に更新。 */
  private renderTimed(): void {
    this.renderLaws();
    this.renderRevolt();
  }

  /** 村長 (§17): 現村長名/任期 + 匿名世論調査 (支持率/人気候補/わからない・みんなきらい・きょうみない)。 */
  private renderMayor(): void {
    this.mayorBox.replaceChildren();
    this.pollBox.replaceChildren();
    const w = this.world;
    if (!w) {
      this.mayorBox.appendChild(kv('👑 村長', '(接続待ち)'));
      return;
    }
    const mayor = w.mayorId ? w.villagers.find((v) => v.id === w.mayorId) : null;
    this.mayorBox.appendChild(kv('👑 村長', mayor ? `${mayor.name} (${mayor.species})` : '(空位)'));
    this.mayorBox.appendChild(kv('🗳 次の選挙', `あと ${w.mayorTermsLeft}日`));

    const poll = w.mayorPoll;
    if (!poll) {
      this.pollBox.appendChild(hint('世論調査は選挙の半年前から (半月ごと更新)'));
      return;
    }
    this.pollBox.appendChild(subLabel('匿名世論調査'));
    this.pollBox.appendChild(kv('📊 村長支持率', pct(poll.approval)));
    for (const c of poll.candidates) {
      this.pollBox.appendChild(kv(`⭐ ${c.name}`, pct(c.support)));
    }
    this.pollBox.appendChild(kv('🤷 わからない', pct(poll.dontKnow)));
    this.pollBox.appendChild(kv('😠 みんなきらい', pct(poll.hate)));
    this.pollBox.appendChild(kv('😐 きょうみない', pct(poll.noInterest)));
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
/** 0..1 を百分率表記にする (§17 世論調査)。 */
function pct(n: number): string {
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
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
