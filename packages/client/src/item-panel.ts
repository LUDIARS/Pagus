// アイテムパネル (§16 + §v1.4-A')。人手でフィールドにアイテムを配置する UI と、
// 場所を荒らす/清める (spot) の UI。アイテムはカルマ消費なし・ランダム配布、
// spot はカルマ消費 (置く位置/場所効果は server/sim が決める)。

import type { WireWorld } from '@pagus/sim';

type ItemKind = 'random' | 'precious' | 'drug';

/** 場所介入 (§v1.4-A') の対象。sim の PLACES (placeAt ラベル) と一致させる。 */
const SPOT_PLACES = ['広場', '住宅地', '村はずれ'] as const;

export interface ItemHandlers {
  /** アイテムを配置する。toChampion=true で推しに直接送る。 */
  onPlace(kind: ItemKind, toChampion: boolean): void;
  /** 場所を荒らす/清める (§v1.4-A')。 */
  onSpot(place: string, mode: 'defile' | 'bless'): void;
}

export interface ItemPanelOptions {
  /** 場所を荒らす/清める操作を表示するか。機能自体は server に残す。 */
  showSpot?: boolean;
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
  private place: string = SPOT_PLACES[0];
  private readonly placeButtons = new Map<string, HTMLButtonElement>();
  private spotCost = 0;
  private readonly defileBtn = document.createElement('button');
  private readonly blessBtn = document.createElement('button');

  constructor(
    private readonly root: HTMLElement,
    private readonly h: ItemHandlers,
    private readonly options: ItemPanelOptions = {},
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

    if (this.options.showSpot ?? true) {
      // 場所介入 (§v1.4-A'): 荒らす/清める。
      const head2 = document.createElement('h3');
      head2.textContent = '🗺 場所';
      this.root.appendChild(head2);
      this.root.appendChild(hint('場所そのものを荒らす/清める。その場の住民が即反応し、効果は数日残る。'));
      this.root.appendChild(subLabel('場所'));
      const placeRow = document.createElement('div');
      placeRow.className = 'item-kinds';
      for (const place of SPOT_PLACES) {
        const btn = document.createElement('button');
        btn.className = 'item-kind-btn';
        btn.textContent = place;
        btn.addEventListener('click', () => this.selectPlace(place));
        placeRow.appendChild(btn);
        this.placeButtons.set(place, btn);
      }
      this.root.appendChild(placeRow);
      this.defileBtn.className = 'item-btn spot-defile';
      this.defileBtn.addEventListener('click', () => this.h.onSpot(this.place, 'defile'));
      this.blessBtn.className = 'item-btn spot-bless';
      this.blessBtn.addEventListener('click', () => this.h.onSpot(this.place, 'bless'));
      this.root.append(this.defileBtn, this.blessBtn);
    }

    this.selectKind('random');
    this.selectPlace(SPOT_PLACES[0]);
    this.renderSpot();
  }

  /** 場所介入のコスト表示を playerState から更新する。 */
  setCosts(spotCost: number): void {
    this.spotCost = spotCost;
    if (!(this.options.showSpot ?? true)) return;
    this.renderSpot();
  }

  private selectPlace(place: string): void {
    this.place = place;
    for (const [p, btn] of this.placeButtons) btn.classList.toggle('active', p === place);
  }

  private renderSpot(): void {
    const cost = this.spotCost > 0 ? ` (−${this.spotCost})` : '';
    this.defileBtn.textContent = `💀 荒らす${cost}`;
    this.blessBtn.textContent = `✨ 清める${cost}`;
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
