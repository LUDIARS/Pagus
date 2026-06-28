// プレイヤー操作パネル (§4)。カルマ/善性/制裁コスト/応援クールダウンを表示し、
// どうぶつを 1 体選んで 扇動 / 制裁 / 応援 する。対象選択は <select> で行う。

import type { WireWorld } from '@pagus/sim';

/** その接続ユーザの状態 (playerState 受信)。 */
export interface PlayerStateView {
  karma: number;
  virtue: number;
  sanctionCost: number;
  canCheerInMs: number;
}

export type ActionType = 'incite' | 'sanction' | 'cheer';

export interface ControlHandlers {
  /** 対象 id を伴って操作を送る。扇動は rumorAboutId (悪口の主) を任意で伴う (§4.2)。 */
  onAction(type: ActionType, targetId: string, rumorAboutId?: string): void;
}

export class PlayerControls {
  private world: WireWorld | null = null;
  private state: PlayerStateView | null = null;
  private selectedId: string | null = null;
  /** 扇動の噂の主 (誰の悪口を吹き込むか, §4.2)。未選択は null。 */
  private rumorAboutId: string | null = null;

  private readonly stateBox = document.createElement('div');
  private readonly select = document.createElement('select');
  private readonly rumorSelect = document.createElement('select');

  constructor(
    private readonly root: HTMLElement,
    private readonly h: ControlHandlers,
  ) {
    this.root.replaceChildren();
    this.root.appendChild(heading('🎯 操作'));
    this.stateBox.className = 'ctl-state';
    this.root.appendChild(this.stateBox);

    this.root.appendChild(subLabel('対象どうぶつ'));
    this.select.className = 'target-select';
    this.select.addEventListener('change', () => {
      this.selectedId = this.select.value || null;
    });
    this.root.appendChild(this.select);

    // 扇動の噂の主 (§4.2): 「誰の悪口か」を選ぶ第2セレクタ。未選択 = 漠然とした不穏な噂。
    this.root.appendChild(subLabel('悪口の主 (扇動)'));
    this.rumorSelect.className = 'target-select';
    this.rumorSelect.addEventListener('change', () => {
      this.rumorAboutId = this.rumorSelect.value || null;
    });
    this.root.appendChild(this.rumorSelect);

    const btns = document.createElement('div');
    btns.className = 'ctl-btns';
    btns.append(
      this.actionButton('🔥 扇動', 'incite', 'btn-incite'),
      this.actionButton('⚖ 制裁', 'sanction', 'btn-sanction'),
      this.actionButton('🌸 応援', 'cheer', 'btn-cheer'),
    );
    this.root.appendChild(btns);
    this.root.appendChild(hint('扇動=偽情報で事件化を促す / 制裁=即つるし上げ裁判 / 応援=気質を後押し'));

    this.renderState();
  }

  setWorld(world: WireWorld): void {
    this.world = world;
    this.refreshTargets();
  }

  setState(s: PlayerStateView): void {
    this.state = s;
    this.renderState();
  }

  /** 生存どうぶつで select を作り直す。選択中が退場していたら先頭へ。 */
  private refreshTargets(): void {
    const w = this.world;
    if (!w) return;
    const alive = w.villagers.filter((v) => v.alive);
    if (this.selectedId && !alive.some((v) => v.id === this.selectedId)) {
      this.selectedId = null;
    }
    if (!this.selectedId && alive.length > 0) this.selectedId = alive[0]?.id ?? null;

    this.select.replaceChildren();
    for (const v of alive) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.name} (${v.species})`;
      if (v.id === this.selectedId) opt.selected = true;
      this.select.appendChild(opt);
    }
    if (alive.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(どうぶつがいません)';
      this.select.appendChild(opt);
    }

    // 噂の主セレクタ (§4.2): 先頭に「(指定なし)」、続いて生存どうぶつ。退場済みはリセット。
    if (this.rumorAboutId && !alive.some((v) => v.id === this.rumorAboutId)) {
      this.rumorAboutId = null;
    }
    this.rumorSelect.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '(指定なし)';
    if (!this.rumorAboutId) none.selected = true;
    this.rumorSelect.appendChild(none);
    for (const v of alive) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.name} (${v.species})`;
      if (v.id === this.rumorAboutId) opt.selected = true;
      this.rumorSelect.appendChild(opt);
    }
  }

  private renderState(): void {
    this.stateBox.replaceChildren();
    const s = this.state;
    if (!s) {
      this.stateBox.appendChild(hint('接続待ち…'));
      return;
    }
    this.stateBox.appendChild(kv('💠 カルマ', s.karma.toFixed(1)));
    this.stateBox.appendChild(kv('😇 善性', s.virtue.toFixed(2)));
    this.stateBox.appendChild(kv('⚖ 制裁コスト', s.sanctionCost.toFixed(1)));
    const cd = s.canCheerInMs;
    this.stateBox.appendChild(kv('🌸 応援', cd <= 0 ? 'いま可能' : `あと ${Math.ceil(cd / 1000)}秒`));
  }

  private actionButton(label: string, type: ActionType, cls: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = cls;
    btn.addEventListener('click', () => {
      const id = this.selectedId;
      if (!id) return;
      // 扇動のときだけ噂の主 (rumorAboutId) を伴わせる (§4.2)。未選択なら省略。
      if (type === 'incite' && this.rumorAboutId) this.h.onAction(type, id, this.rumorAboutId);
      else this.h.onAction(type, id);
    });
    return btn;
  }
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
