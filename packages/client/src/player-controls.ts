// プレイヤー行動パネル (§4)。指定された行動を消費カルマ付きボタンとして描画し、
// 押下後に対象選択ダイアログを開く。

import type { Villager, WireWorld } from '@pagus/sim';
import { villagerDisplayName } from './villager-display.js';

export interface PlayerStateView {
  karma: number;
  virtue: number;
  sanctionCost: number;
  inciteCost: number;
  canCheerInMs: number;
  canIntervene: boolean;
  heckleCost: number;
  canHeckleInMs: number;
  testifyCost: number;
  giftTreatCost: number;
  giftPoisonCost: number;
  spotCost: number;
  fanFlamesCost: number;
  championId: string | null;
  championName?: string;
}

export type ActionType = 'incite' | 'sanction' | 'cheer';
export type PlayerCommand = ActionType | 'champion' | 'gift-treat' | 'gift-poison' | 'fanFlames';

export interface ControlHandlers {
  onAction(type: ActionType, targetId: string, rumorAboutId?: string): void;
  onChampion(targetId: string): void;
  onVerdict(pick: 'kill' | 'spare'): void;
  onGift(targetId: string, kind: 'treat' | 'poison'): void;
  onFanFlames(targetId: string): void;
}

interface CommandMeta {
  label: string;
  dialogTitle: string;
  excludeChampion: boolean;
  needsRumor: boolean;
}

const COMMANDS: Record<PlayerCommand, CommandMeta> = {
  incite: { label: '🔥 扇動', dialogTitle: '扇動する相手', excludeChampion: true, needsRumor: true },
  sanction: { label: '⚖ 制裁', dialogTitle: '制裁する相手', excludeChampion: false, needsRumor: false },
  cheer: { label: '🌸 応援', dialogTitle: '応援する相手', excludeChampion: false, needsRumor: false },
  champion: { label: '⭐ 推し指名', dialogTitle: '推しにする住民', excludeChampion: false, needsRumor: false },
  'gift-treat': { label: '🍬 差し入れ', dialogTitle: '差し入れる相手', excludeChampion: false, needsRumor: false },
  'gift-poison': { label: '☠ 毒饅頭', dialogTitle: '毒饅頭を渡す相手', excludeChampion: true, needsRumor: false },
  fanFlames: { label: '📢 言いふらす', dialogTitle: '噂を広げる相手', excludeChampion: false, needsRumor: false },
};

const DEFAULT_COMMANDS: PlayerCommand[] = ['incite', 'sanction', 'cheer', 'champion', 'gift-treat', 'gift-poison', 'fanFlames'];

export interface PlayerControlsOptions {
  commands?: readonly PlayerCommand[];
  showVerdict?: boolean;
}

export class PlayerControls {
  private world: WireWorld | null = null;
  private state: PlayerStateView | null = null;
  private command: PlayerCommand;
  private rumorAboutId: string | null = null;
  private verdictCooldownUntil = 0;
  private poisonLabel: string | null = null;

  private readonly commands: readonly PlayerCommand[];
  private readonly showVerdict: boolean;
  private readonly commandRow = document.createElement('div');
  private readonly cmdBar = document.createElement('div');
  private readonly verdictBox = document.createElement('div');
  private readonly cmdButtons = new Map<PlayerCommand, HTMLButtonElement>();
  private readonly dialogBackdrop = document.createElement('div');
  private readonly dialogTitle = document.createElement('div');
  private readonly dialogBody = document.createElement('div');
  private readonly rumorSelect = document.createElement('select');

  constructor(
    private readonly root: HTMLElement,
    private readonly h: ControlHandlers,
    options: PlayerControlsOptions = {},
  ) {
    this.commands = options.commands ?? DEFAULT_COMMANDS;
    this.showVerdict = options.showVerdict ?? true;
    this.command = this.commands[0] ?? 'cheer';
    this.root.replaceChildren();

    this.commandRow.className = 'dock-row dock-action-row';

    this.cmdBar.className = 'dock-commands';
    for (const cmd of this.commands) {
      const btn = document.createElement('button');
      btn.className = `dock-cmd-btn cmd-${cmd}`;
      btn.addEventListener('click', () => this.openDialog(cmd));
      this.cmdBar.appendChild(btn);
      this.cmdButtons.set(cmd, btn);
    }
    this.commandRow.appendChild(this.cmdBar);
    this.root.appendChild(this.commandRow);

    this.verdictBox.className = 'dock-verdict';
    this.verdictBox.append(
      verdictButton('死刑', 'dock-verdict-kill', () => this.voteVerdict('kill')),
      verdictButton('教育', 'dock-verdict-spare', () => this.voteVerdict('spare')),
    );
    if (this.showVerdict) this.root.appendChild(this.verdictBox);

    this.buildDialog();
    this.renderState();
    setInterval(() => this.renderState(), 1000);
  }

  setWorld(world: WireWorld): void {
    this.world = world;
    this.renderState();
    if (this.isDialogOpen()) this.renderDialog();
  }

  setPoisonLabel(label: string): void {
    this.poisonLabel = label;
    this.renderState();
  }

  setState(s: PlayerStateView): void {
    this.state = s;
    this.renderState();
    if (this.isDialogOpen()) this.renderDialog();
  }

  private buildDialog(): void {
    this.dialogBackdrop.className = 'dock-dialog-backdrop';
    const dialog = document.createElement('div');
    dialog.className = 'dock-dialog';
    dialog.addEventListener('click', (e) => e.stopPropagation());

    const head = document.createElement('div');
    head.className = 'dock-dialog-head';
    this.dialogTitle.className = 'dock-dialog-title';
    const close = document.createElement('button');
    close.className = 'dock-dialog-close';
    close.textContent = '×';
    close.addEventListener('click', () => this.closeDialog());
    head.append(this.dialogTitle, close);

    this.dialogBody.className = 'dock-dialog-body';
    dialog.append(head, this.dialogBody);
    this.dialogBackdrop.appendChild(dialog);
    this.dialogBackdrop.addEventListener('click', () => this.closeDialog());
    this.root.appendChild(this.dialogBackdrop);

    this.rumorSelect.className = 'dock-dialog-select';
    this.rumorSelect.addEventListener('change', () => {
      this.rumorAboutId = this.rumorSelect.value || null;
    });
  }

  private openDialog(cmd: PlayerCommand): void {
    const btn = this.cmdButtons.get(cmd);
    if (btn?.disabled) return;
    this.command = cmd;
    this.renderDialog();
    this.dialogBackdrop.classList.add('show');
  }

  private closeDialog(): void {
    this.dialogBackdrop.classList.remove('show');
  }

  private isDialogOpen(): boolean {
    return this.dialogBackdrop.classList.contains('show');
  }

  private renderDialog(): void {
    const meta = COMMANDS[this.command];
    this.dialogTitle.textContent = `${this.commandLabel(this.command)}: ${meta.dialogTitle}`;
    this.dialogBody.replaceChildren();

    if (meta.needsRumor) this.dialogBody.appendChild(this.rumorField());

    const targets = this.targetsFor(this.command);
    if (targets.length === 0) {
      this.dialogBody.appendChild(div('対象にできる住民がいません。', 'muted'));
      return;
    }

    const grid = div('', 'dock-target-grid');
    for (const v of targets) {
      const btn = document.createElement('button');
      btn.className = 'dock-target-btn';
      btn.textContent = this.targetLabel(v);
      btn.addEventListener('click', () => this.executeTarget(v.id));
      grid.appendChild(btn);
    }
    this.dialogBody.appendChild(grid);
  }

  private rumorField(): HTMLElement {
    this.fillRumorSelect();
    const box = div('', 'dock-dialog-field');
    const label = document.createElement('label');
    label.className = 'dock-dialog-label';
    label.textContent = '噂の主';
    box.append(label, this.rumorSelect);
    return box;
  }

  private fillRumorSelect(): void {
    const alive = this.aliveVillagers();
    if (this.rumorAboutId && !alive.some((v) => v.id === this.rumorAboutId)) this.rumorAboutId = null;

    this.rumorSelect.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '指定なし';
    none.selected = !this.rumorAboutId;
    this.rumorSelect.appendChild(none);

    for (const v of alive) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${this.displayName(v)} (${v.species})`;
      opt.selected = v.id === this.rumorAboutId;
      this.rumorSelect.appendChild(opt);
    }
  }

  private aliveVillagers(): Villager[] {
    return this.world?.villagers.filter((v) => v.alive) ?? [];
  }

  private targetsFor(cmd: PlayerCommand): Villager[] {
    const championId = this.state?.championId ?? null;
    const exclude = COMMANDS[cmd].excludeChampion;
    return this.aliveVillagers().filter((v) => !(exclude && v.id === championId));
  }

  private targetLabel(v: Villager): string {
    const champ = this.state?.championId === v.id ? ' / 推し' : '';
    return `${this.displayName(v)} (${v.species})${champ}`;
  }

  private displayName(v: Villager): string {
    return this.world ? villagerDisplayName(this.world, v) : v.name;
  }

  private costOf(cmd: PlayerCommand): number {
    const s = this.state;
    if (!s) return 0;
    if (cmd === 'incite') return s.inciteCost;
    if (cmd === 'sanction') return Math.round(s.sanctionCost);
    if (cmd === 'gift-treat') return s.giftTreatCost;
    if (cmd === 'gift-poison') return s.giftPoisonCost;
    if (cmd === 'fanFlames') return s.fanFlamesCost;
    return 0;
  }

  private commandLabel(cmd: PlayerCommand): string {
    return cmd === 'gift-poison' && this.poisonLabel ? this.poisonLabel : COMMANDS[cmd].label;
  }

  private costText(cmd: PlayerCommand): string {
    if (!this.state) return '...';
    const cd = Math.max(0, this.state.canCheerInMs);
    if (cmd === 'cheer' && cd > 0) return `あと${Math.ceil(cd / 1000)}s`;
    const cost = this.costOf(cmd);
    return cost > 0 ? `消費 ${cost}カルマ` : '無料';
  }

  private renderState(): void {
    const verdictActive = this.world?.phase === 'ten' && this.world.trial?.stage === 'fate';
    const verdictCooling = Date.now() < this.verdictCooldownUntil;
    const canIntervene = this.state?.canIntervene ?? false;
    this.commandRow.style.display = 'flex';
    this.verdictBox.style.display = this.showVerdict && verdictActive ? 'flex' : 'none';
    this.root.classList.toggle('dock-intervention-disabled', !canIntervene);
    if (!canIntervene && this.isDialogOpen()) this.closeDialog();

    for (const btn of this.verdictBox.querySelectorAll('button')) {
      (btn as HTMLButtonElement).disabled = !this.showVerdict || !verdictActive || verdictCooling;
    }

    const cheerCd = this.state ? Math.max(0, this.state.canCheerInMs) : 0;
    for (const cmd of this.commands) {
      const btn = this.cmdButtons.get(cmd);
      if (!btn) continue;
      btn.replaceChildren();
      const lab = document.createElement('span');
      lab.className = 'dock-cmd-label';
      lab.textContent = this.commandLabel(cmd);
      const cost = document.createElement('span');
      cost.className = 'dock-cmd-cost';
      cost.textContent = this.costText(cmd);
      btn.append(lab, cost);
      btn.disabled = !canIntervene || !this.world || !this.state || this.targetsFor(cmd).length === 0 || (cmd === 'cheer' && cheerCd > 0);
    }
  }

  private executeTarget(id: string): void {
    if (this.command === 'champion') this.h.onChampion(id);
    else if (this.command === 'gift-treat' || this.command === 'gift-poison') {
      this.h.onGift(id, this.command === 'gift-treat' ? 'treat' : 'poison');
    } else if (this.command === 'fanFlames') {
      this.h.onFanFlames(id);
    } else if (this.command === 'incite') {
      this.h.onAction('incite', id, this.rumorAboutId ?? undefined);
    } else {
      this.h.onAction(this.command, id);
    }
    this.closeDialog();
  }

  private voteVerdict(pick: 'kill' | 'spare'): void {
    if (!(this.world?.phase === 'ten' && this.world.trial?.stage === 'fate')) return;
    if (Date.now() < this.verdictCooldownUntil) return;
    this.verdictCooldownUntil = Date.now() + 3500;
    this.h.onVerdict(pick);
    this.renderState();
  }
}

function verdictButton(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `dock-verdict-btn ${cls}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function div(text: string, cls: string): HTMLElement {
  const el = document.createElement('div');
  if (text) el.textContent = text;
  el.className = cls;
  return el;
}
