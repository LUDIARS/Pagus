// プレイヤー行動パネル (§4)。画面下の独立ドック (#action-dock) に常時表示する2段 UI:
//   ① コマンドを選ぶ (扇動 / 制裁 / 応援 / 推し指名。各ボタンに消費カルマを併記) →
//   ② 対象を選ぶ → 実行。
// 扇動は推しを対象から除外する (推しに誤って扇動しないため §4.2)。実行時の手応えは
// main がステージのリアクション吹き出しで返す (扇動のリアクションが無い問題への対応)。

import type { WireWorld } from '@pagus/sim';

/** その接続ユーザの状態 (playerState 受信)。 */
export interface PlayerStateView {
  karma: number;
  virtue: number;
  sanctionCost: number;
  /** 扇動の固定コスト (§4 消費カルマ表示用)。 */
  inciteCost: number;
  canCheerInMs: number;
  /** 野次の固定コスト (§v1.4-A)。 */
  heckleCost: number;
  /** 次に野次できるまでの残りミリ秒 (§v1.4-A)。 */
  canHeckleInMs: number;
  /** 証言の固定コスト (§v1.4-A)。 */
  testifyCost: number;
  /** 差し入れの固定コスト (§v1.4-A)。 */
  giftTreatCost: number;
  /** 毒饅頭の固定コスト (§v1.4-A)。 */
  giftPoisonCost: number;
  /** 推し (champion) の villager id。未指名は null (§1)。 */
  championId: string | null;
  /** 推しの名前 (server が world から補完)。 */
  championName?: string;
}

export type ActionType = 'incite' | 'sanction' | 'cheer';
/** ドックで選べるコマンド (行動)。champion = 推し指名 / gift-* = 贈り物 (§v1.4-A)。 */
type Command = ActionType | 'champion' | 'gift-treat' | 'gift-poison';

export interface ControlHandlers {
  /** 対象 id を伴って操作を送る。扇動は rumorAboutId (悪口の主) を任意で伴う (§4.2)。 */
  onAction(type: ActionType, targetId: string, rumorAboutId?: string): void;
  /** 選択中の対象を推しに指名する (§1)。 */
  onChampion(targetId: string): void;
  /** 選択中の対象へ贈り物を手渡す (§v1.4-A)。 */
  onGift(targetId: string, kind: 'treat' | 'poison'): void;
}

/** コマンドの表示メタ。 */
interface CommandMeta {
  label: string;
  /** 推しを対象から外すか (扇動のみ true)。 */
  excludeChampion: boolean;
  /** 悪口の主セレクタを出すか (扇動のみ)。 */
  needsRumor: boolean;
}
const COMMANDS: Record<Command, CommandMeta> = {
  incite: { label: '🔥 扇動', excludeChampion: true, needsRumor: true },
  sanction: { label: '⚖ 制裁', excludeChampion: false, needsRumor: false },
  cheer: { label: '🌸 応援', excludeChampion: false, needsRumor: false },
  champion: { label: '⭐ 推し指名', excludeChampion: false, needsRumor: false },
  'gift-treat': { label: '🍬 差し入れ', excludeChampion: false, needsRumor: false },
  'gift-poison': { label: '☠ 毒饅頭', excludeChampion: true, needsRumor: false },
};
const COMMAND_ORDER: Command[] = ['incite', 'sanction', 'cheer', 'champion', 'gift-treat', 'gift-poison'];

export class PlayerControls {
  private world: WireWorld | null = null;
  private state: PlayerStateView | null = null;
  private command: Command = 'incite';
  private selectedId: string | null = null;
  /** 扇動の噂の主 (誰の悪口を吹き込むか, §4.2)。未選択は null。 */
  private rumorAboutId: string | null = null;

  private readonly stateBox = document.createElement('div');
  private readonly cmdBar = document.createElement('div');
  private readonly select = document.createElement('select');
  private readonly rumorField = document.createElement('div');
  private readonly rumorSelect = document.createElement('select');
  private readonly execBtn = document.createElement('button');
  private readonly cmdButtons = new Map<Command, HTMLButtonElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly h: ControlHandlers,
  ) {
    this.root.replaceChildren();
    const row = document.createElement('div');
    row.className = 'dock-row';

    const title = document.createElement('span');
    title.className = 'dock-title';
    title.textContent = '🎯 行動';
    this.stateBox.className = 'dock-state';
    row.append(title, this.stateBox);

    // ① コマンド選択 (消費カルマ併記)。
    this.cmdBar.className = 'dock-commands';
    for (const cmd of COMMAND_ORDER) {
      const btn = document.createElement('button');
      btn.className = `dock-cmd-btn cmd-${cmd}`;
      btn.addEventListener('click', () => this.selectCommand(cmd));
      this.cmdBar.appendChild(btn);
      this.cmdButtons.set(cmd, btn);
    }
    row.appendChild(this.cmdBar);

    // ② 対象選択。
    this.select.className = 'dock-select';
    this.select.addEventListener('change', () => {
      this.selectedId = this.select.value || null;
    });
    row.appendChild(dockField('対象', this.select));

    // 扇動の噂の主 (§4.2)。扇動のときだけ出す。
    this.rumorSelect.className = 'dock-select';
    this.rumorSelect.addEventListener('change', () => {
      this.rumorAboutId = this.rumorSelect.value || null;
    });
    this.rumorField.className = 'dock-field';
    {
      const l = document.createElement('span');
      l.className = 'dock-field-label';
      l.textContent = '悪口の主';
      this.rumorField.append(l, this.rumorSelect);
    }
    row.appendChild(this.rumorField);

    // 実行ボタン。
    this.execBtn.className = 'dock-btn dock-exec';
    this.execBtn.addEventListener('click', () => this.execute());
    row.appendChild(this.execBtn);

    this.root.appendChild(row);
    this.selectCommand('incite');
    this.renderState();
    // 応援クールダウンの残りを毎秒詰める (state 再送を待たずに表示/活性を進める)。
    setInterval(() => this.renderState(), 1000);
  }

  setWorld(world: WireWorld): void {
    this.world = world;
    this.refreshTargets();
  }

  setState(s: PlayerStateView): void {
    this.state = s;
    this.refreshTargets(); // 推し変化を対象除外へ反映
    this.renderState();
  }

  /** コマンドを選ぶ (①)。対象リスト・噂の主表示・実行ボタンを切り替える。 */
  private selectCommand(cmd: Command): void {
    this.command = cmd;
    for (const [c, btn] of this.cmdButtons) btn.classList.toggle('active', c === cmd);
    this.rumorField.style.display = COMMANDS[cmd].needsRumor ? '' : 'none';
    this.refreshTargets();
    this.renderState();
  }

  /** 現コマンドの消費カルマ (表示用)。応援/推し指名は 0 (無料)。 */
  private costOf(cmd: Command): number {
    const s = this.state;
    if (!s) return 0;
    if (cmd === 'incite') return s.inciteCost;
    if (cmd === 'sanction') return Math.round(s.sanctionCost);
    if (cmd === 'gift-treat') return s.giftTreatCost;
    if (cmd === 'gift-poison') return s.giftPoisonCost;
    return 0;
  }

  /** 生存どうぶつで対象 select を作り直す。扇動は推しを除外する。 */
  private refreshTargets(): void {
    const w = this.world;
    if (!w) return;
    const championId = this.state?.championId ?? null;
    const exclude = COMMANDS[this.command].excludeChampion;
    const alive = w.villagers.filter((v) => v.alive && !(exclude && v.id === championId));

    if (this.selectedId && !alive.some((v) => v.id === this.selectedId)) this.selectedId = null;
    if (!this.selectedId && alive.length > 0) this.selectedId = alive[0]?.id ?? null;

    fillSelect(this.select, alive, this.selectedId, '(対象がいません)');

    // 噂の主 (§4.2): 先頭に「(指定なし)」、続いて生存どうぶつ。退場済みはリセット。
    const aliveAll = w.villagers.filter((v) => v.alive);
    if (this.rumorAboutId && !aliveAll.some((v) => v.id === this.rumorAboutId)) this.rumorAboutId = null;
    this.rumorSelect.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '(指定なし)';
    if (!this.rumorAboutId) none.selected = true;
    this.rumorSelect.appendChild(none);
    for (const v of aliveAll) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.name} (${v.species})`;
      if (v.id === this.rumorAboutId) opt.selected = true;
      this.rumorSelect.appendChild(opt);
    }
  }

  /** 状態チップ + 実行ボタンのラベル/活性を描画する。 */
  private renderState(): void {
    const s = this.state;
    this.stateBox.replaceChildren();
    if (!s) {
      this.stateBox.appendChild(chip('接続待ち…', ''));
    } else {
      const champ = s.championId ? (s.championName ?? '指名中') : '未指名';
      this.stateBox.append(
        chip('💠 カルマ', s.karma.toFixed(1)),
        chip('😇 善性', s.virtue.toFixed(2)),
        chip('⭐ 推し', champ),
      );
    }
    // コマンドボタンのコスト併記 + 応援クールダウン表示。
    const cd = s ? Math.max(0, s.canCheerInMs) : 0;
    for (const cmd of COMMAND_ORDER) {
      const btn = this.cmdButtons.get(cmd);
      if (!btn) continue;
      btn.replaceChildren();
      const lab = document.createElement('span');
      lab.className = 'dock-cmd-label';
      lab.textContent = COMMANDS[cmd].label;
      const cost = document.createElement('span');
      cost.className = 'dock-cmd-cost';
      cost.textContent = costLabel(cmd, this.costOf(cmd), cd);
      btn.append(lab, cost);
      // 応援はクールダウン中は不可。
      btn.disabled = cmd === 'cheer' && cd > 0;
    }
    // 実行ボタン。
    const meta = COMMANDS[this.command];
    const c = this.costOf(this.command);
    this.execBtn.textContent = `${meta.label} を実行${c > 0 ? ` (−${c})` : ''}`;
    this.execBtn.disabled = !this.selectedId || (this.command === 'cheer' && cd > 0);
  }

  /** 実行 (②の後)。選択中のコマンド+対象でハンドラを呼ぶ。 */
  private execute(): void {
    const id = this.selectedId;
    if (!id) return;
    if (this.command === 'champion') {
      this.h.onChampion(id);
      return;
    }
    if (this.command === 'gift-treat' || this.command === 'gift-poison') {
      this.h.onGift(id, this.command === 'gift-treat' ? 'treat' : 'poison');
      return;
    }
    if (this.command === 'incite' && this.rumorAboutId) this.h.onAction('incite', id, this.rumorAboutId);
    else this.h.onAction(this.command, id);
  }
}

/** 生存どうぶつで select を作り直す共通処理。 */
function fillSelect(sel: HTMLSelectElement, alive: { id: string; name: string; species: string }[], selectedId: string | null, emptyText: string): void {
  sel.replaceChildren();
  for (const v of alive) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `${v.name} (${v.species})`;
    if (v.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  }
  if (alive.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = emptyText;
    sel.appendChild(opt);
  }
}

/** コマンドボタンに出すコスト文。応援はクールダウンを、無料系は「無料」を出す。 */
function costLabel(cmd: Command, cost: number, cheerCdMs: number): string {
  if (cmd === 'cheer') return cheerCdMs > 0 ? `あと${Math.ceil(cheerCdMs / 1000)}s` : '無料';
  if (cost <= 0) return '無料';
  return `−${cost}`;
}

function dockField(label: string, select: HTMLSelectElement): HTMLElement {
  const box = document.createElement('div');
  box.className = 'dock-field';
  const l = document.createElement('span');
  l.className = 'dock-field-label';
  l.textContent = label;
  box.append(l, select);
  return box;
}

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
