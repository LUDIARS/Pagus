import type { WireWorld, VillagerGachaKind, LeaderboardEntry, Villager } from '@pagus/sim';
import { HOBBY_LABELS, KARMA_GACHA_COST, PERSONALITY_LABELS, dominantAxis, isAwake, lifeProfileFor, routineTextFor, sleepRoutineTextFor, timeOfDayForSegment } from '@pagus/sim';
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
  private readonly brainBox = document.createElement('div');
  private readonly championBox = document.createElement('div');
  private readonly relBox = document.createElement('div');
  private readonly historyBox = document.createElement('div');
  private readonly actionBox = document.createElement('div');
  private readonly modal = document.createElement('div');
  private readonly modalBody = document.createElement('div');

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

    this.root.appendChild(sub('住民LLM脳'));
    this.brainBox.className = 'resident-list';
    this.root.appendChild(this.brainBox);

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
    this.setupModal();
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

  showVillagerDetails(villagerId: string): void {
    const w = this.world;
    if (!w) return;
    const villager = w.villagers.find((v) => v.id === villagerId);
    if (!villager) return;
    this.modalBody.replaceChildren();
    this.modalBody.appendChild(villagerDetails(w, villager));
    this.modal.classList.add('show');
  }

  private render(): void {
    const w = this.world;
    this.statusBox.replaceChildren();
    this.brainBox.replaceChildren();
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
        `脳:${brainLabelFor(w, v.id)}`,
        `活動:${activityLabel(v.activity)}`,
        awake ? '起床中' : '睡眠中',
        relationLabel(w, v, byId, alive),
        `日課:${routine}`,
        recent ? `最近:${recent}` : null,
      ].filter((s): s is string => s !== null).join(' / ');
      this.statusBox.appendChild(row(`${v.name} (${v.species})`, meta, () => this.showVillagerDetails(v.id)));
    }

    for (const v of w.villagers.filter((x) => x.alive).sort((a, b) => a.name.localeCompare(b.name))) {
      this.brainBox.appendChild(row(`${v.name} (${v.species})`, `LLM脳: ${brainLabelFor(w, v.id)}`, () => this.showVillagerDetails(v.id)));
    }

    const championRows = this.leaderboard.filter((p) => p.championId);
    const championIds = [...new Set(championRows.map((p) => p.championId).filter((id): id is string => !!id && alive.has(id)))];
    if (championRows.length === 0) {
      this.championBox.appendChild(hint('推し指定はまだありません'));
    } else {
      for (const p of championRows.slice(0, 12)) {
        const champion = p.championId ? byId.get(p.championId) ?? p.championId : '未指定';
        this.championBox.appendChild(row(p.userName ?? p.userId.slice(0, 8), `推し: ${champion}`, p.championId ? () => this.showVillagerDetails(p.championId as string) : undefined));
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
      const namedBy = h.namedByName ? `命名:${h.namedByName}` : null;
      this.historyBox.appendChild(row(`${residentHistoryDisplayName(w, h)} (${h.species})`, [originLabel(h.origin), h.archetype ?? '通常', brain, namedBy].filter((s): s is string => s !== null).join(' / ')));
    }

    for (const a of [...(w.villagerActionLog ?? [])].reverse().slice(0, 14)) {
      this.actionBox.appendChild(row(`${a.date} ${a.villagerName}`, a.text));
    }
  }

  private setupModal(): void {
    this.modal.className = 'resident-modal';
    const box = document.createElement('div');
    box.className = 'resident-modal-box';
    const head = document.createElement('div');
    head.className = 'resident-modal-head';
    const title = document.createElement('div');
    title.className = 'resident-modal-title';
    title.textContent = '住民詳細';
    const close = document.createElement('button');
    close.className = 'resident-modal-close';
    close.textContent = '×';
    close.addEventListener('click', () => this.modal.classList.remove('show'));
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.modal.classList.remove('show');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.modal.classList.remove('show');
    });
    this.modalBody.className = 'resident-modal-body';
    head.append(title, close);
    box.append(head, this.modalBody);
    this.modal.appendChild(box);
    document.body.appendChild(this.modal);
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

function row(title: string, meta: string, onClick?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = onClick ? 'resident-row resident-row-clickable' : 'resident-row';
  if (onClick) {
    el.tabIndex = 0;
    el.role = 'button';
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    });
  }
  const t = document.createElement('div');
  t.className = 'resident-title';
  t.textContent = title;
  const m = document.createElement('div');
  m.className = 'resident-meta';
  m.textContent = meta;
  el.append(t, m);
  return el;
}

function villagerDetails(w: WireWorld, v: Villager): HTMLElement {
  const box = document.createElement('div');
  box.className = 'resident-detail';
  const names = villagerNameMap(w);
  const alive = new Set(w.villagers.filter((x) => x.alive).map((x) => x.id));
  const profile = lifeProfileFor(v);
  const now = timeOfDayForSegment(w.calendar.segment, w.config.segmentsPerDay);
  const awake = isAwake(v.activity, w.calendar.segment, w.config.segmentsPerDay);
  const latest = latestActionByVillager(w).get(v.id);
  const routine = awake ? routineTextFor(v, now) : sleepRoutineTextFor(now);

  const hero = document.createElement('div');
  hero.className = 'resident-detail-hero';
  hero.append(
    detailIdentity(`${v.name} (${v.species})`, [
      v.alive ? '生存' : '退場',
      originLabel(v.origin),
      activityLabel(v.activity),
      awake ? '起床中' : '睡眠中',
      profile.label,
    ]),
    statPills([
      ['LLM', brainLabelFor(w, v.id)],
      ['気分', v.emotion.label],
      ['趣味', HOBBY_LABELS[v.hobby]],
      ['所持', String(Math.round(v.wealth))],
    ]),
  );
  box.appendChild(hero);

  const grid = document.createElement('div');
  grid.className = 'resident-detail-grid';
  grid.append(
    detailCard('現在', [
      metric('場所', `${v.position.x}, ${v.position.y}`),
      metric('日課', routine),
      metric('直近行動', latest ?? 'なし'),
      meter('ストレス', Math.min(1, v.stress / 10), String(v.stress)),
    ]),
    detailCard('日々のルーティーン', [
      timeline('朝', profile.routine.morning),
      timeline('昼', profile.routine.noon),
      timeline('夕', profile.routine.evening),
      timeline('夜', profile.routine.night),
    ]),
    detailCard('事件の火種', [
      metric('種', profile.incident.description),
      meter('発火しやすさ', profile.incident.triggerWeight, triggerLabel(profile.incident.triggerWeight)),
    ]),
    detailCard('性格', [
      metric('主軸', PERSONALITY_LABELS[dominantAxis(v.persona.traits)]),
      ...Object.entries(v.persona.traits).map(([axis, value]) => meter(PERSONALITY_LABELS[axis as keyof typeof PERSONALITY_LABELS] ?? axis, value, value.toFixed(2))),
    ]),
    detailCard('関係', relationshipLines(w, v, names, alive).map((line) => metric('', line))),
    detailCard('信条と記憶', [
      metric('信条', v.persona.values.join(' / ') || 'なし'),
      metric('口調', v.persona.speechStyle),
      ...v.information.slice(-4).map((info) => metric('記憶', info.text)),
    ]),
  );
  box.appendChild(grid);
  return box;
}

function detailIdentity(name: string, badges: string[]): HTMLElement {
  const box = document.createElement('div');
  const h = document.createElement('div');
  h.className = 'resident-detail-title';
  h.textContent = name;
  const row = document.createElement('div');
  row.className = 'resident-detail-badges';
  for (const badge of badges) {
    const b = document.createElement('span');
    b.textContent = badge;
    row.appendChild(b);
  }
  box.append(h, row);
  return box;
}

function statPills(items: [string, string][]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'resident-detail-pills';
  for (const [label, value] of items) {
    const pill = document.createElement('div');
    pill.className = 'resident-detail-pill';
    pill.append(labelEl(label), valueEl(value));
    box.appendChild(pill);
  }
  return box;
}

function detailCard(title: string, items: HTMLElement[]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'resident-detail-card';
  const h = document.createElement('div');
  h.className = 'resident-detail-card-title';
  h.textContent = title;
  box.appendChild(h);
  if (items.length === 0) box.appendChild(metric('', 'なし'));
  else for (const item of items) box.appendChild(item);
  return box;
}

function metric(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = label ? 'resident-detail-metric' : 'resident-detail-metric no-label';
  if (label) row.appendChild(labelEl(label));
  row.appendChild(valueEl(value));
  return row;
}

function meter(label: string, raw: number, value: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'resident-detail-meter';
  const head = document.createElement('div');
  head.className = 'resident-detail-meter-head';
  head.append(labelEl(label), valueEl(value));
  const track = document.createElement('div');
  track.className = 'resident-detail-meter-track';
  const fill = document.createElement('i');
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, raw)) * 100)}%`;
  track.appendChild(fill);
  box.append(head, track);
  return box;
}

function timeline(label: string, value: string): HTMLElement {
  const row = metric(label, value);
  row.classList.add('resident-detail-timeline');
  return row;
}

function labelEl(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'resident-detail-label';
  el.textContent = text;
  return el;
}

function valueEl(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'resident-detail-value';
  el.textContent = text;
  return el;
}

function triggerLabel(weight: number): string {
  if (weight >= 0.7) return '高';
  if (weight >= 0.45) return '中';
  return '低';
}

const RELATION_GROUP_LIMIT = 6;
const RELATION_NAMED_LIMIT = 3;

type RelationGroupKey =
  | 'spouse'
  | 'romance'
  | 'envy'
  | 'grudge'
  | 'enemy'
  | 'trust'
  | 'like'
  | 'faithWorship'
  | 'faithBelief'
  | 'faithRecognition'
  | 'neutral';

interface RelationGroup {
  key: RelationGroupKey;
  priority: number;
  countNoun: '村人' | '神';
  strength: number;
  targets: Map<string, string>;
}

function relationshipLines(w: WireWorld, v: Villager, names: Map<string, string>, alive: Set<string>): string[] {
  const groups = new Map<RelationGroupKey, RelationGroup>();
  if (v.partnerId && alive.has(v.partnerId)) {
    addRelationGroup(groups, 'spouse', v.partnerId, names.get(v.partnerId) ?? v.partnerId, 100);
  }
  for (const rel of (w.relationships ?? []).filter((r) => r.from === v.id && alive.has(r.to))) {
    if (rel.kind === 'spouse' && rel.to === v.partnerId) continue;
    const key = relationGroupKey(rel);
    addRelationGroup(groups, key, rel.to, names.get(rel.to) ?? rel.to, Math.abs(rel.affinity));
  }
  for (const faith of (w.userFaith ?? []).filter((f) => f.villagerId === v.id && f.faith >= 25)) {
    const key = faith.title === '崇拝' ? 'faithWorship' : faith.title === '信仰' ? 'faithBelief' : 'faithRecognition';
    addRelationGroup(groups, key, faith.userId, userFaithLabel(faith.userId), faith.faith);
  }
  return [...groups.values()]
    .sort((a, b) => a.priority - b.priority || b.strength - a.strength || a.key.localeCompare(b.key))
    .slice(0, RELATION_GROUP_LIMIT)
    .map(formatRelationGroup);
}

function addRelationGroup(
  groups: Map<RelationGroupKey, RelationGroup>,
  key: RelationGroupKey,
  targetId: string,
  targetName: string,
  strength: number,
): void {
  let group = groups.get(key);
  if (!group) {
    group = {
      key,
      priority: relationGroupPriority(key),
      countNoun: key.startsWith('faith') ? '神' : '村人',
      strength,
      targets: new Map(),
    };
    groups.set(key, group);
  }
  group.targets.set(targetId, targetName);
  group.strength = Math.max(group.strength, strength);
}

function relationGroupKey(rel: WireWorld['relationships'][number]): RelationGroupKey {
  if (rel.kind === 'spouse') return 'spouse';
  if (rel.kind === 'romance') return 'romance';
  const note = rel.note;
  if (/妬|嫉妬/.test(note)) return 'envy';
  if (/恨|遺恨|忘れない|冤罪|偽証|処刑/.test(note)) return 'grudge';
  if (rel.hates || rel.affinity <= REL_HATE_THRESHOLD || /敵|警戒|嫌/.test(note)) return 'enemy';
  if (rel.affinity >= 70 || /心を許|大切/.test(note)) return 'trust';
  if (rel.affinity >= REL_LIKE_THRESHOLD || /好意/.test(note)) return 'like';
  return 'neutral';
}

function relationGroupPriority(key: RelationGroupKey): number {
  switch (key) {
    case 'spouse':
      return 0;
    case 'romance':
      return 1;
    case 'envy':
      return 2;
    case 'grudge':
      return 3;
    case 'enemy':
      return 4;
    case 'trust':
      return 5;
    case 'like':
      return 6;
    case 'faithWorship':
      return 7;
    case 'faithBelief':
      return 8;
    case 'faithRecognition':
      return 9;
    case 'neutral':
      return 10;
  }
}

function formatRelationGroup(group: RelationGroup): string {
  const names = [...group.targets.values()];
  const target = names.length <= RELATION_NAMED_LIMIT
    ? joinJapaneseNames(names)
    : `${names.length}人の${group.countNoun}`;
  switch (group.key) {
    case 'spouse':
      return names.length <= RELATION_NAMED_LIMIT ? `${target}と夫婦である` : `${target}と夫婦関係にある`;
    case 'romance':
      return `${target}に恋愛感情を持っている`;
    case 'envy':
      return `${target}を妬んでいる`;
    case 'grudge':
      return `${target}を恨んでいる`;
    case 'enemy':
      return `${target}に敵意を持っている`;
    case 'trust':
      return `${target}に心を許している`;
    case 'like':
      return `${target}に好意を持っている`;
    case 'faithWorship':
      return `${target}を崇拝している`;
    case 'faithBelief':
      return `${target}を信仰している`;
    case 'faithRecognition':
      return `${target}を神として認識している`;
    case 'neutral':
      return `${target}の様子を見ている`;
  }
}

function joinJapaneseNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]}と${names[1]}`;
  return names.join('、');
}

function userFaithLabel(userId: string): string {
  return userId.length > 6 ? `神:${userId.slice(0, 6)}` : `神:${userId}`;
}

function brainLabelFor(w: WireWorld, villagerId: string): string {
  const history = (w.residentHistory ?? []).find((h) => h.id === villagerId);
  return history?.llmBrain ?? 'stub';
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
