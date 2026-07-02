import type { WireWorld, VillagerGachaKind } from '@pagus/sim';
import { KARMA_GACHA_COST } from '@pagus/sim';
import { residentHistoryDisplayName, villagerNameMap } from './villager-display.js';

const REL_HATE_THRESHOLD = -35;
const REL_LIKE_THRESHOLD = 45;
const GRAPH_EDGE_LIMIT = 48;
const GRAPH_NODE_LIMIT = 22;
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ResidentPanelHandlers {
  onGacha(kind: VillagerGachaKind): void;
}

export interface ResidentPanelOptions {
  showGacha?: boolean;
}

export class ResidentPanel {
  private world: WireWorld | null = null;
  private readonly gachaBox = document.createElement('div');
  private readonly relBox = document.createElement('div');
  private readonly historyBox = document.createElement('div');
  private readonly actionBox = document.createElement('div');

  constructor(
    private readonly root: HTMLElement,
    private readonly h: ResidentPanelHandlers,
    private readonly options: ResidentPanelOptions = {},
  ) {
    this.root.replaceChildren();
    this.root.appendChild(heading('村人'));

    if (this.options.showGacha ?? true) {
      this.gachaBox.appendChild(gachaButtons((kind) => this.h.onGacha(kind)));
      this.root.appendChild(this.gachaBox);
    }

    this.root.appendChild(sub('関係図'));
    this.relBox.className = 'resident-list';
    this.root.appendChild(this.relBox);

    this.root.appendChild(sub('住民履歴'));
    this.historyBox.className = 'resident-list';
    this.root.appendChild(this.historyBox);

    this.root.appendChild(sub('住民の行動記録'));
    this.actionBox.className = 'resident-list';
    this.root.appendChild(this.actionBox);
    this.render();
  }

  setWorld(world: WireWorld): void {
    this.world = world;
    this.render();
  }

  private render(): void {
    const w = this.world;
    this.relBox.replaceChildren();
    this.historyBox.replaceChildren();
    this.actionBox.replaceChildren();
    if (!w) {
      this.relBox.appendChild(hint('接続待ち'));
      return;
    }

    const byId = villagerNameMap(w);
    const edges = strongRelationships(w);
    if (edges.length === 0) {
      this.relBox.appendChild(hint('強い好意・嫌悪関係はまだありません'));
    } else {
      this.relBox.appendChild(relationshipGraph(edges, byId));
      for (const r of edges.slice(0, 14)) {
        const sign = r.affinity >= REL_LIKE_THRESHOLD ? '好意' : '嫌悪';
        this.relBox.appendChild(row(`${byId.get(r.from) ?? r.from} → ${byId.get(r.to) ?? r.to}`, `${sign} ${r.affinity} / ${r.note}`));
      }
    }

    for (const h of [...(w.residentHistory ?? [])].reverse().slice(0, 10)) {
      const brain = h.llmBrain ? `脳:${h.llmBrain}` : '脳:stub';
      this.historyBox.appendChild(row(`${residentHistoryDisplayName(w, h)} (${h.species})`, `${originLabel(h.origin)} / ${h.archetype ?? '通常'} / ${brain}`));
    }

    for (const a of [...(w.villagerActionLog ?? [])].reverse().slice(0, 14)) {
      this.actionBox.appendChild(row(`${a.date} ${a.villagerName}`, a.text));
    }
  }
}

export class ResidentGachaPanel {
  constructor(
    private readonly root: HTMLElement,
    private readonly h: ResidentPanelHandlers,
  ) {
    this.root.replaceChildren();
    this.root.appendChild(heading('村人ガチャ'));
    this.root.appendChild(gachaButtons((kind) => this.h.onGacha(kind), true));
  }
}

function heading(text: string): HTMLElement {
  const el = document.createElement('h3');
  el.textContent = text;
  return el;
}

function sub(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sub';
  el.textContent = text;
  return el;
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = cls;
  el.textContent = text;
  el.addEventListener('click', onClick);
  return el;
}

function gachaButtons(onGacha: (kind: VillagerGachaKind) => void, showStatus = false): HTMLElement {
  const box = document.createElement('div');
  const buttons = document.createElement('div');
  const status = document.createElement('div');
  box.className = 'resident-gacha-box';
  buttons.className = 'resident-gacha';
  status.className = 'resident-gacha-status muted';
  const click = (kind: VillagerGachaKind): void => {
    onGacha(kind);
    if (!showStatus) return;
    for (const btn of Array.from(buttons.querySelectorAll<HTMLButtonElement>('button'))) btn.disabled = true;
    status.textContent = '送信しました。介入はゲーム内時間で1日1回までです。';
    setTimeout(() => {
      for (const btn of Array.from(buttons.querySelectorAll<HTMLButtonElement>('button'))) btn.disabled = false;
      status.textContent = '';
    }, 1800);
  };
  buttons.append(
    button('無料ガチャ', 'resident-btn', () => click('free')),
    button(`カルマガチャ (${KARMA_GACHA_COST})`, 'resident-btn resident-karma', () => click('karma')),
  );
  box.appendChild(buttons);
  if (showStatus) box.appendChild(status);
  return box;
}

function row(title: string, meta: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'resident-row';
  const t = document.createElement('div');
  t.className = 'resident-title';
  t.textContent = title;
  const m = document.createElement('div');
  m.className = 'resident-meta';
  m.textContent = meta;
  el.append(t, m);
  return el;
}

function strongRelationships(w: WireWorld): WireWorld['relationships'] {
  const alive = new Set(w.villagers.filter((v) => v.alive).map((v) => v.id));
  return [...(w.relationships ?? [])]
    .filter((r) => alive.has(r.from) && alive.has(r.to) && (r.affinity <= REL_HATE_THRESHOLD || r.affinity >= REL_LIKE_THRESHOLD))
    .sort((a, b) => Math.abs(b.affinity) - Math.abs(a.affinity))
    .slice(0, GRAPH_EDGE_LIMIT);
}

function relationshipGraph(edges: WireWorld['relationships'], names: Map<string, string>): HTMLElement {
  const selected: typeof edges = [];
  const nodes = new Set<string>();
  for (const edge of edges) {
    const nextSize = new Set([...nodes, edge.from, edge.to]).size;
    if (nextSize > GRAPH_NODE_LIMIT) continue;
    selected.push(edge);
    nodes.add(edge.from);
    nodes.add(edge.to);
  }

  const box = document.createElement('div');
  box.className = 'relationship-graph';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'relationship-svg');
  svg.setAttribute('viewBox', '0 0 320 240');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '住民関係図');
  box.appendChild(svg);

  const ids = [...nodes];
  const cx = 160;
  const cy = 116;
  const radius = Math.max(52, 92 - Math.max(0, ids.length - 12) * 1.8);
  const pos = new Map<string, { x: number; y: number }>();
  ids.forEach((id, i) => {
    const angle = ids.length === 1 ? 0 : (Math.PI * 2 * i) / ids.length - Math.PI / 2;
    pos.set(id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  });

  for (const edge of selected) {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    if (!a || !b) continue;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x));
    line.setAttribute('y2', String(b.y));
    line.setAttribute('class', edge.affinity >= REL_LIKE_THRESHOLD ? 'rel-edge-pos' : 'rel-edge-neg');
    line.setAttribute('stroke-width', String(1 + Math.min(3, Math.abs(edge.affinity) / 28)));
    line.setAttribute('stroke-opacity', edge.affinity >= REL_LIKE_THRESHOLD ? '0.62' : '0.72');
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${names.get(edge.from) ?? edge.from} -> ${names.get(edge.to) ?? edge.to}: ${edge.affinity}`;
    line.appendChild(title);
    svg.appendChild(line);
  }

  for (const id of ids) {
    const p = pos.get(id);
    if (!p) continue;
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(p.x));
    circle.setAttribute('cy', String(p.y));
    circle.setAttribute('r', '9');
    circle.setAttribute('class', 'rel-node-dot');
    svg.appendChild(circle);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(p.x));
    label.setAttribute('y', String(p.y + 18));
    label.setAttribute('class', 'rel-node-label');
    label.textContent = shortName(names.get(id) ?? id);
    svg.appendChild(label);
  }

  const legend = document.createElement('div');
  legend.className = 'rel-legend';
  legend.innerHTML = '<span class="rel-legend-pos">好意 +45以上</span><span class="rel-legend-neg">嫌悪 -35以下</span>';
  box.appendChild(legend);
  return box;
}

function shortName(name: string): string {
  return Array.from(name).slice(0, 5).join('');
}

function hint(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'muted';
  el.textContent = text;
  return el;
}

function originLabel(origin: string): string {
  if (origin === 'freeGacha') return '無料ガチャ';
  if (origin === 'karmaGacha') return 'カルマガチャ';
  if (origin === 'born') return '出生';
  if (origin === 'incident') return '事件由来';
  return '初期住民';
}
