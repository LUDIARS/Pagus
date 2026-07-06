import type { WireWorld, VillagerGachaKind, LeaderboardEntry, Villager } from '@pagus/sim';
import { KARMA_GACHA_COST, isAwake, lifeProfileFor, routineTextFor, sleepRoutineTextFor, timeOfDayForSegment } from '@pagus/sim';
import { residentHistoryDisplayName, villagerNameMap } from './villager-display.js';

const REL_HATE_THRESHOLD = -35;
const REL_LIKE_THRESHOLD = 45;
const FAITH_GRAPH_THRESHOLD = 45;
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
  private leaderboard: LeaderboardEntry[] = [];
  private readonly gachaBox = document.createElement('div');
  private readonly statusBox = document.createElement('div');
  private readonly championBox = document.createElement('div');
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

    this.root.appendChild(sub('生活ステータス'));
    this.statusBox.className = 'resident-list resident-status-list';
    this.root.appendChild(this.statusBox);

    this.root.appendChild(sub('他ユーザーの推し'));
    this.championBox.className = 'resident-list';
    this.root.appendChild(this.championBox);

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

  setLeaderboard(players: LeaderboardEntry[]): void {
    this.leaderboard = players;
    this.render();
  }

  private render(): void {
    const w = this.world;
    this.statusBox.replaceChildren();
    this.championBox.replaceChildren();
    this.relBox.replaceChildren();
    this.historyBox.replaceChildren();
    this.actionBox.replaceChildren();
    if (!w) {
      this.relBox.appendChild(hint('接続待ち'));
      return;
    }

    const byId = villagerNameMap(w);
    const userNames = new Map(this.leaderboard.map((p) => [p.userId, p.userName ?? p.userId.slice(0, 8)]));
    for (const f of w.userFaith ?? []) {
      if (!userNames.has(f.userId)) userNames.set(f.userId, f.userId.slice(0, 8));
    }
    for (const [uid, name] of userNames) byId.set(`user:${uid}`, `神:${name}`);

    const alive = new Set(w.villagers.filter((v) => v.alive).map((v) => v.id));
    const now = timeOfDayForSegment(w.calendar.segment, w.config.segmentsPerDay);
    const latestAction = latestActionByVillager(w);
    for (const v of w.villagers.filter((x) => x.alive).sort((a, b) => a.name.localeCompare(b.name))) {
      const profile = lifeProfileFor(v);
      const awake = isAwake(v.activity, w.calendar.segment, w.config.segmentsPerDay);
      const routine = awake ? routineTextFor(v, now) : sleepRoutineTextFor(now);
      const recent = latestAction.get(v.id);
      const meta = [
        `職能:${profile.label}`,
        `活動:${activityLabel(v.activity)}`,
        awake ? '起床中' : '睡眠中',
        relationLabel(w, v, byId, alive),
        `日課:${routine}`,
        recent ? `最近:${recent}` : null,
      ].filter((s): s is string => s !== null).join(' / ');
      this.statusBox.appendChild(row(`${v.name} (${v.species})`, meta));
    }

    const championRows = this.leaderboard.filter((p) => p.championId);
    const championIds = [...new Set(championRows.map((p) => p.championId).filter((id): id is string => !!id && alive.has(id)))];
    if (championRows.length === 0) {
      this.championBox.appendChild(hint('推し指定はまだありません'));
    } else {
      for (const p of championRows.slice(0, 12)) {
        const champion = p.championId ? byId.get(p.championId) ?? p.championId : '未指定';
        this.championBox.appendChild(row(p.userName ?? p.userId.slice(0, 8), `推し: ${champion}`));
      }
    }

    const edges = displayRelationships(w, championRows);
    if (edges.length === 0) {
      this.relBox.appendChild(relationshipGraph([], byId, championIds));
      this.relBox.appendChild(hint(championIds.length === 0 ? '夫婦・恋愛・推し関係はまだありません' : '推しと強く関係している住民はまだありません'));
    } else {
      this.relBox.appendChild(relationshipGraph(edges, byId, championIds));
      for (const r of edges.slice(0, 14)) {
        const sign =
          r.kind === 'spouse'
            ? '夫婦'
            : r.kind === 'romance'
              ? '恋愛'
              : r.kind === 'faith'
                ? '信仰'
                : r.affinity >= REL_LIKE_THRESHOLD ? '好意' : '嫌悪';
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

interface RelationshipEdge {
  from: string;
  to: string;
  affinity: number;
  note: string;
  kind: 'villager' | 'faith' | 'spouse' | 'romance';
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

function latestActionByVillager(w: WireWorld): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of [...(w.villagerActionLog ?? [])].reverse()) {
    if (!out.has(a.villagerId)) out.set(a.villagerId, a.text);
  }
  return out;
}

function relationLabel(w: WireWorld, v: Villager, names: Map<string, string>, alive: Set<string>): string {
  if (v.partnerId && alive.has(v.partnerId)) return `夫婦:${names.get(v.partnerId) ?? v.partnerId}`;
  const romance = (w.relationships ?? []).find((r) => r.from === v.id && r.kind === 'romance' && alive.has(r.to));
  if (romance) return `恋愛:${names.get(romance.to) ?? romance.to}`;
  return '関係:なし';
}

function activityLabel(activity: Villager['activity']): string {
  switch (activity) {
    case 'diurnal':
      return '昼行性';
    case 'nocturnal':
      return '夜行性';
    case 'crepuscular':
      return '薄明性';
    case 'always':
      return '常時活動';
  }
}

function displayRelationships(w: WireWorld, championRows: LeaderboardEntry[]): RelationshipEdge[] {
  const alive = new Set(w.villagers.filter((v) => v.alive).map((v) => v.id));
  const championByUser = new Map<string, string>();
  const championIds = new Set<string>();
  for (const p of championRows) {
    if (!p.championId || !alive.has(p.championId)) continue;
    championByUser.set(p.userId, p.championId);
    championIds.add(p.championId);
  }
  const edges: RelationshipEdge[] = [];
  const specialSeen = new Set<string>();
  for (const r of w.relationships ?? []) {
    if (!alive.has(r.from) || !alive.has(r.to)) continue;
    if (r.kind !== 'spouse' && r.kind !== 'romance') continue;
    const [a, b] = [r.from, r.to].sort();
    const key = `${r.kind}:${a}:${b}`;
    if (specialSeen.has(key)) continue;
    specialSeen.add(key);
    edges.push({
      from: r.from,
      to: r.to,
      affinity: Math.max(r.affinity, r.kind === 'spouse' ? 82 : 68),
      note: r.note,
      kind: r.kind,
    });
  }
  edges.push(...[...(w.relationships ?? [])]
    .filter((r) => (
      alive.has(r.from)
      && alive.has(r.to)
      && r.kind !== 'spouse'
      && r.kind !== 'romance'
      && (championIds.has(r.from) || championIds.has(r.to))
      && (r.affinity <= REL_HATE_THRESHOLD || r.affinity >= REL_LIKE_THRESHOLD)
    ))
    .map((r) => ({ from: r.from, to: r.to, affinity: r.affinity, note: r.note, kind: 'villager' as const })));
  edges.push(...[...(w.userFaith ?? [])]
    .filter((f) => f.faith >= FAITH_GRAPH_THRESHOLD && alive.has(f.villagerId) && championByUser.get(f.userId) === f.villagerId)
    .map((f) => ({
      from: `user:${f.userId}`,
      to: f.villagerId,
      affinity: f.faith,
      note: `${f.title}: ${f.note}`,
      kind: 'faith' as const,
    })));
  return edges
    .sort((a, b) => edgeRank(b) - edgeRank(a) || Math.abs(b.affinity) - Math.abs(a.affinity))
    .slice(0, GRAPH_EDGE_LIMIT);
}

function edgeRank(edge: RelationshipEdge): number {
  if (edge.kind === 'spouse') return 4;
  if (edge.kind === 'romance') return 3;
  if (edge.kind === 'faith') return 2;
  return 1;
}

function relationshipGraph(edges: RelationshipEdge[], names: Map<string, string>, focusIds: string[] = []): HTMLElement {
  const selected: RelationshipEdge[] = [];
  const nodes = new Set<string>(focusIds.slice(0, GRAPH_NODE_LIMIT));
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
    line.setAttribute('class', edge.kind === 'faith' || edge.kind === 'spouse' || edge.kind === 'romance' || edge.affinity >= REL_LIKE_THRESHOLD ? 'rel-edge-pos' : 'rel-edge-neg');
    line.setAttribute('stroke-width', String(1 + Math.min(3, Math.abs(edge.affinity) / 28)));
    line.setAttribute('stroke-opacity', edge.affinity >= REL_LIKE_THRESHOLD ? '0.62' : '0.72');
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${names.get(edge.from) ?? edge.from} -> ${names.get(edge.to) ?? edge.to}: ${edgeLabel(edge)} ${edge.affinity}`;
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
  legend.innerHTML = '<span class="rel-legend-pos">夫婦/恋愛/好意/信仰</span><span class="rel-legend-neg">嫌悪 -35以下</span>';
  box.appendChild(legend);
  return box;
}

function edgeLabel(edge: RelationshipEdge): string {
  if (edge.kind === 'spouse') return '夫婦';
  if (edge.kind === 'romance') return '恋愛';
  if (edge.kind === 'faith') return '信仰';
  return edge.affinity >= REL_LIKE_THRESHOLD ? '好意' : '嫌悪';
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
