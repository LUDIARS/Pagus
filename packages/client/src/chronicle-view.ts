// 村の歴史ビュー (§8)。📜ボタンで開閉するモーダル。
// タブで多面化: ハイライト / 事件 / 住民 / 教育 / 村のルール / 人間の行動記録。
//   データ源は chronicle (entry.kind で分類) / 最新 snapshot (住民・村のルール) / playerActions。
//   分類は server が ChronicleEntry.kind を明示する (絵文字接頭辞依存を廃止, §2.2)。

import { dominantAxis, PERSONALITY_LABELS } from '@pagus/sim';
import type { ChronicleEntry, PlayerActionEntry, WireWorld, Villager } from '@pagus/sim';

type Tab = 'highlight' | 'incidents' | 'villagers' | 'education' | 'rules' | 'actions';

const TABS: { id: Tab; label: string }[] = [
  { id: 'highlight', label: 'ハイライト' },
  { id: 'incidents', label: '事件' },
  { id: 'villagers', label: '住民' },
  { id: 'education', label: '教育' },
  { id: 'rules', label: '村のルール' },
  { id: 'actions', label: '行動記録' },
];

const ACTION_JA: Record<PlayerActionEntry['type'], string> = {
  incite: '扇動',
  sanction: '制裁',
  cheer: '応援',
  heckle: '野次',
  testify: '証言',
  gift: '贈り物',
};

/** しきたり改定 (§2) のコスト表示。既定 env (PAGUS_RULE_ADD_COST/REMOVE_COST) に合わせる。 */
const RULE_ADD_COST = 15;
const RULE_REMOVE_COST = 25;

/** しきたり改定の操作ハンドラ (§2)。 */
export interface RuleHandlers {
  /** 新しいしきたりを定める (カルマを払う)。 */
  onAddRule(text: string): void;
  /** しきたりを廃する (カルマを払う)。 */
  onRemoveRule(ruleId: string): void;
}

export class ChronicleView {
  private entries: ChronicleEntry[] = [];
  private world: WireWorld | null = null;
  private actions: PlayerActionEntry[] = [];
  private open = false;
  private tab: Tab = 'highlight';

  constructor(
    private readonly root: HTMLElement,
    private readonly body: HTMLElement,
    openBtn: HTMLElement,
    closeBtn: HTMLElement,
    private readonly rules?: RuleHandlers,
  ) {
    openBtn.addEventListener('click', () => this.toggle(true));
    closeBtn.addEventListener('click', () => this.toggle(false));
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.toggle(false);
    });
  }

  setEntries(entries: ChronicleEntry[]): void {
    this.entries = entries;
    if (this.open) this.render();
  }

  /** 最新 snapshot を供給 (住民リスト + 村のルール用)。 */
  setWorld(world: WireWorld): void {
    this.world = world;
    if (this.open) this.render();
  }

  /** 人間の行動記録を供給 (§8)。 */
  setActions(actions: PlayerActionEntry[]): void {
    this.actions = actions;
    if (this.open) this.render();
  }

  private toggle(open: boolean): void {
    this.open = open;
    this.root.classList.toggle('show', open);
    if (open) this.render();
  }

  private render(): void {
    this.body.replaceChildren();
    this.body.appendChild(this.tabBar());
    const content = div('', 'hist-content');
    this.body.appendChild(content);
    this.renderTab(content);
  }

  private tabBar(): HTMLElement {
    const bar = div('', 'hist-tabs');
    for (const t of TABS) {
      const btn = document.createElement('button');
      btn.textContent = t.label;
      btn.className = t.id === this.tab ? 'hist-tab active' : 'hist-tab';
      btn.addEventListener('click', () => {
        this.tab = t.id;
        this.render();
      });
      bar.appendChild(btn);
    }
    return bar;
  }

  private renderTab(host: HTMLElement): void {
    switch (this.tab) {
      case 'highlight':
        this.renderEntryList(host, this.incidentEntries().slice(-5).reverse(), '直近の大きな事件はまだありません。');
        break;
      case 'incidents':
        this.renderEntryList(host, this.incidentEntries(), 'まだ事件は起きていません。');
        break;
      case 'education':
        this.renderEntryList(host, this.educationEntries(), 'まだ教育(改変)は行われていません。');
        break;
      case 'villagers':
        this.renderVillagers(host);
        break;
      case 'rules':
        this.renderRules(host);
        break;
      case 'actions':
        this.renderActions(host);
        break;
    }
  }

  /** 事件 = incident(発火/予兆) / reconcile(和解) / sanction(制裁) 種別 (§2.2)。 */
  private incidentEntries(): ChronicleEntry[] {
    return this.entries.filter(
      (e) => e.kind === 'incident' || e.kind === 'reconcile' || e.kind === 'sanction',
    );
  }

  /** 教育 = reform 種別 (§2.2)。 */
  private educationEntries(): ChronicleEntry[] {
    return this.entries.filter((e) => e.kind === 'reform');
  }

  private renderEntryList(host: HTMLElement, list: ChronicleEntry[], emptyMsg: string): void {
    if (list.length === 0) {
      host.appendChild(div(emptyMsg, 'muted'));
      return;
    }
    let lastDate = '';
    for (const e of list) {
      if (e.date !== lastDate) {
        host.appendChild(div(e.date, 'hist-date'));
        lastDate = e.date;
      }
      host.appendChild(div(e.text, 'hist-line'));
    }
  }

  private renderVillagers(host: HTMLElement): void {
    const w = this.world;
    if (!w || w.villagers.length === 0) {
      host.appendChild(div('住民の情報がありません。', 'muted'));
      return;
    }
    // 生存を先に、退場者を後ろに。
    const sorted = [...w.villagers].sort((a, b) => Number(b.alive) - Number(a.alive));
    for (const v of sorted) {
      host.appendChild(this.villagerRow(v));
    }
  }

  private villagerRow(v: Villager): HTMLElement {
    const row = div('', v.alive ? 'hist-villager' : 'hist-villager gone');
    const dom = PERSONALITY_LABELS[dominantAxis(v.persona.traits)];
    const originJa = v.origin === 'incident' ? '事件キャラ' : v.origin === 'born' ? '出生' : '元住民';
    const title = `${v.alive ? '' : '✝ '}${v.name} (${v.species})`;
    const meta = `気質: ${dom} ｜ 改変 ${v.reformCount}回 ｜ ${originJa}`;
    row.appendChild(div(title, 'hist-villager-name'));
    row.appendChild(div(meta, 'hist-villager-meta'));
    return row;
  }

  private renderRules(host: HTMLElement): void {
    const rules = this.world?.villageRules ?? [];
    // しきたり改定 UI (§2): 新しい掟を定める入力 (ハンドラがあるときのみ)。
    if (this.rules) host.appendChild(this.addRuleForm());
    if (rules.length === 0) {
      host.appendChild(div('この村にはまだしきたりがありません。', 'muted'));
      return;
    }
    host.appendChild(div('村のしきたり (事件の火種)', 'hist-date'));
    for (const r of rules) {
      const row = div('', 'hist-rule-row');
      row.appendChild(div(`・${r.text}`, 'hist-line'));
      if (this.rules) {
        const rm = document.createElement('button');
        rm.textContent = `廃する (${RULE_REMOVE_COST})`;
        rm.className = 'rule-remove-btn';
        rm.addEventListener('click', () => this.rules?.onRemoveRule(r.id));
        row.appendChild(rm);
      }
      host.appendChild(row);
    }
  }

  /** 新しいしきたりを定める入力フォーム (§2)。 */
  private addRuleForm(): HTMLElement {
    const box = div('', 'rule-add-box');
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 40;
    input.placeholder = '新しいしきたり (1〜40文字)';
    input.className = 'rule-add-input';
    const btn = document.createElement('button');
    btn.textContent = `掟を定める (${RULE_ADD_COST})`;
    btn.className = 'rule-add-btn';
    const submit = (): void => {
      const text = input.value.trim();
      if (text.length < 1) return;
      this.rules?.onAddRule(text);
      input.value = '';
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    box.append(input, btn);
    return box;
  }

  private renderActions(host: HTMLElement): void {
    if (this.actions.length === 0) {
      host.appendChild(div('まだ人間の操作はありません。', 'muted'));
      return;
    }
    // 新しい順に。
    let lastDate = '';
    for (const a of [...this.actions].reverse()) {
      if (a.date !== lastDate) {
        host.appendChild(div(a.date, 'hist-date'));
        lastDate = a.date;
      }
      host.appendChild(div(`${ACTION_JA[a.type]} → ${a.target} （${a.userId}）`, 'hist-line'));
    }
  }
}

function div(text: string, cls: string): HTMLElement {
  const el = document.createElement('div');
  if (text) el.textContent = text;
  el.className = cls;
  return el;
}
