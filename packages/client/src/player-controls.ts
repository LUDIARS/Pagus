// プレイヤー行動パネル (§4)。画面下の独立ドック (#action-dock) に常時表示する横並びバー。
// カルマ/善性/制裁コスト/応援クールダウン/推し を左にチップ表示し、どうぶつを 1 体選んで
// 扇動 / 制裁 / 応援 / 推し指名 する。PC・モバイル共通で画面下に出す (レスポンシブで折り返す)。

import type { WireWorld } from '@pagus/sim';

/** その接続ユーザの状態 (playerState 受信)。 */
export interface PlayerStateView {
  karma: number;
  virtue: number;
  sanctionCost: number;
  canCheerInMs: number;
  /** 推し (champion) の villager id。未指名は null (§1)。 */
  championId: string | null;
  /** 推しの名前 (server が world から補完)。 */
  championName?: string;
}

export type ActionType = 'incite' | 'sanction' | 'cheer';

export interface ControlHandlers {
  /** 対象 id を伴って操作を送る。扇動は rumorAboutId (悪口の主) を任意で伴う (§4.2)。 */
  onAction(type: ActionType, targetId: string, rumorAboutId?: string): void;
  /** 選択中の対象を推しに指名する (§1)。 */
  onChampion(targetId: string): void;
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
    const row = document.createElement('div');
    row.className = 'dock-row';

    // 左: タイトル + 自分の状態チップ。
    const title = document.createElement('span');
    title.className = 'dock-title';
    title.textContent = '🎯 行動';
    this.stateBox.className = 'dock-state';
    row.append(title, this.stateBox);

    // 中: 対象どうぶつ + 悪口の主 (扇動)。
    this.select.className = 'dock-select';
    this.select.addEventListener('change', () => {
      this.selectedId = this.select.value || null;
    });
    // 扇動の噂の主 (§4.2): 「誰の悪口か」を選ぶ第2セレクタ。未選択 = 漠然とした不穏な噂。
    this.rumorSelect.className = 'dock-select';
    this.rumorSelect.addEventListener('change', () => {
      this.rumorAboutId = this.rumorSelect.value || null;
    });
    row.append(
      dockField('対象', this.select),
      dockField('悪口の主', this.rumorSelect),
    );

    // 右: 行動ボタン群。
    const btns = document.createElement('div');
    btns.className = 'dock-actions';
    btns.append(
      this.actionButton('🔥 扇動', 'incite', 'btn-incite', '偽情報で事件化を促す'),
      this.actionButton('⚖ 制裁', 'sanction', 'btn-sanction', '即つるし上げ裁判'),
      this.actionButton('🌸 応援', 'cheer', 'btn-cheer', '気質を後押し'),
      this.championButton(),
    );
    row.append(btns);

    this.root.appendChild(row);
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
      this.stateBox.appendChild(chip('接続待ち…', ''));
      return;
    }
    const cd = s.canCheerInMs;
    const champ = s.championId ? (s.championName ?? s.championId) : '未指名';
    this.stateBox.append(
      chip('💠 カルマ', s.karma.toFixed(1)),
      chip('😇 善性', s.virtue.toFixed(2)),
      chip('⚖ 制裁', s.sanctionCost.toFixed(1)),
      chip('🌸 応援', cd <= 0 ? '可' : `${Math.ceil(cd / 1000)}s`),
      chip('⭐ 推し', champ),
    );
  }

  private actionButton(label: string, type: ActionType, cls: string, tip: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = `dock-btn ${cls}`;
    btn.title = tip;
    btn.addEventListener('click', () => {
      const id = this.selectedId;
      if (!id) return;
      // 扇動のときだけ噂の主 (rumorAboutId) を伴わせる (§4.2)。未選択なら省略。
      if (type === 'incite' && this.rumorAboutId) this.h.onAction(type, id, this.rumorAboutId);
      else this.h.onAction(type, id);
    });
    return btn;
  }

  /** 推し指名 (§1): 選択中の対象を推しにする。生存中はカルマ加速。 */
  private championButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = '⭐ 推し指名';
    btn.className = 'dock-btn btn-champion';
    btn.title = '推しが生存中はカルマ加速。死ぬとカルマ罰 + 弔いの掟が生まれる';
    btn.addEventListener('click', () => {
      const id = this.selectedId;
      if (id) this.h.onChampion(id);
    });
    return btn;
  }
}

/** ラベル付きセレクタ (小ラベル + select) を縦に組む。 */
function dockField(label: string, select: HTMLSelectElement): HTMLElement {
  const box = document.createElement('div');
  box.className = 'dock-field';
  const l = document.createElement('span');
  l.className = 'dock-field-label';
  l.textContent = label;
  box.append(l, select);
  return box;
}

/** 状態チップ (ラベル + 値)。値が空ならラベルのみ。 */
function chip(label: string, value: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'dock-chip';
  const l = document.createElement('span');
  l.className = 'dock-chip-label';
  l.textContent = label;
  box.appendChild(l);
  if (value) {
    const v = document.createElement('span');
    v.className = 'dock-chip-val';
    v.textContent = value;
    box.appendChild(v);
  }
  return box;
}
