// アイテムパネル (§16)。人手でフィールドにアイテムを配置する UI。
// 種別 (ランダム / 貴金属 / 薬物) を選び、「フィールドに置く」か「推しに送る」。
// カルマ消費なし・ランダム配布 (置く位置は server がランダムに決める)。

import type { WireWorld } from '@pagus/sim';

type ItemKind = 'random' | 'precious' | 'drug';

export interface ItemHandlers {
  /** アイテムを配置する。toChampion=true で推しに直接送る。 */
  onPlace(kind: ItemKind, toChampion: boolean): void;
}

const KINDS: { value: ItemKind; label: string }[] = [
  { value: 'random', label: '🎲 ランダム' },
  { value: 'precious', label: '💎 貴金属' },
  { value: 'drug', label: '💊 薬物' },
];

export class ItemPanel {
  private kind: ItemKind = 'random';
  private world: WireWorld | null = null;
  private readonly countBox = document.createElement('div');
  private readonly kindButtons = new Map<ItemKind, HTMLButtonElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly h: ItemHandlers,
  ) {
    this.root.replaceChildren();
    const head = document.createElement('h3');
    head.textContent = '🎁 アイテム';
    this.root.appendChild(head);
    this.root.appendChild(hint('フィールドに配るアイテム (カルマ消費なし・ランダム配布)。貴金属=拾うと富む / 薬物=拾うと荒れる。'));

    // 種別選択。
    this.root.appendChild(subLabel('種別'));
    const kindRow = document.createElement('div');
    kindRow.className = 'item-kinds';
    for (const k of KINDS) {
      const btn = document.createElement('button');
      btn.className = 'item-kind-btn';
      btn.textContent = k.label;
      btn.addEventListener('click', () => this.selectKind(k.value));
      kindRow.appendChild(btn);
      this.kindButtons.set(k.value, btn);
    }
    this.root.appendChild(kindRow);
    this.countBox.className = 'item-counts';
    this.root.appendChild(this.countBox);

    // 配置ボタン。
    this.root.appendChild(this.actionBtn('🗺 フィールドに置く', 'item-field', () => this.h.onPlace(this.kind, false)));
    this.root.appendChild(this.actionBtn('⭐ 推しに送る', 'item-champion', () => this.h.onPlace(this.kind, true)));
    this.root.appendChild(hint('「推しに送る」は先に推しを指名しておくこと。'));

    this.selectKind('random');
  }

  setWorld(world: WireWorld): void {
    this.world = world;
    this.renderCounts();
  }

  private selectKind(kind: ItemKind): void {
    this.kind = kind;
    for (const [k, btn] of this.kindButtons) btn.classList.toggle('active', k === kind);
    this.renderCounts();
  }

  private counts(): Record<ItemKind, number> {
    const precious = this.world?.items.filter((i) => i.kind === 'precious').length ?? 0;
    const drug = this.world?.items.filter((i) => i.kind === 'drug').length ?? 0;
    return { random: precious + drug, precious, drug };
  }

  private renderCounts(): void {
    const counts = this.counts();
    this.countBox.replaceChildren(
      countChip('所持合計', counts.random),
      countChip('貴金属', counts.precious),
      countChip('薬物', counts.drug),
    );
    for (const k of KINDS) {
      const btn = this.kindButtons.get(k.value);
      if (btn) btn.textContent = `${k.label} (${counts[k.value]})`;
    }
  }

  private actionBtn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = `item-btn ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }
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
function countChip(label: string, value: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'item-count';
  el.textContent = `${label}: ${value}`;
  return el;
}
