// 左パネル: いま事件を起こしている (or 被告の) 住民のステータス。
// 事件が無ければプレースホルダ。気質6軸 / 感情 / 改変回数 / 事件内容を出す。

import { PERSONALITY_AXES, PERSONALITY_LABELS, dominantAxis } from '@pagus/sim';
import type { WireWorld, Villager, PersonalityAxis } from '@pagus/sim';
import { ResidentPortraits } from './resident-portrait.js';
import { villagerDisplayName } from './villager-display.js';

const AXIS_COLOR: Record<PersonalityAxis, string> = {
  kindness: '#6fcf97',
  aggression: '#eb5757',
  sociability: '#f2c94c',
  curiosity: '#56ccf2',
  discipline: '#9b97f2',
  ambition: '#f2994a',
};

export class IncidentPanel {
  private readonly portraits = new ResidentPortraits();
  destroy(): void { this.portraits.destroy(); }
  constructor(private readonly root: HTMLElement) {}

  update(world: WireWorld): void {
    const inc = world.incident;
    const byId = new Map(world.villagers.map((v) => [v.id, v]));
    const targetId = world.trial?.defendant ?? inc?.perpetrator ?? null;
    const target = targetId ? byId.get(targetId) ?? null : null;

    this.portraits.reset();
    this.root.replaceChildren();
    this.root.appendChild(h('h3', '🔥 事件の当事者'));

    if (!target) {
      this.root.appendChild(p('muted', '今は事件が起きていません。'));
      return;
    }

    this.root.appendChild(this.identity(world, target));

    if (inc) {
      this.root.appendChild(h('div', '事件', 'sub'));
      this.root.appendChild(p('desc', inc.description));
      this.root.appendChild(p('muted', `被害 ${inc.damage}`));
    }

    this.root.appendChild(h('div', '気質 6 軸', 'sub'));
    const dom = dominantAxis(target.persona.traits);
    for (const ax of PERSONALITY_AXES) {
      this.root.appendChild(bar(PERSONALITY_LABELS[ax], target.persona.traits[ax], AXIS_COLOR[ax], ax === dom));
    }

    this.root.appendChild(h('div', '感情', 'sub'));
    this.root.appendChild(p('desc', `${target.emotion.label || '—'}`));

    this.root.appendChild(p('muted', `改変回数 ${target.reformCount}　信条: ${target.persona.values.join(' / ') || 'なし'}`));
  }

  private identity(world: WireWorld, v: Villager): HTMLElement {
    const box = document.createElement('div');
    box.className = 'ident';
    const img = this.portraits.create(v);
    img.className = 'ident-face';
    const txt = document.createElement('div');
    txt.appendChild(h('div', villagerDisplayName(world, v), 'ident-name'));
    txt.appendChild(p('muted', `${v.species}・${activityJa(v.activity)}${v.madman ? '・狂人' : ''}`));
    box.append(img, txt);
    return box;
  }
}

function activityJa(a: Villager['activity']): string {
  return { diurnal: '昼行性', nocturnal: '夜行性', crepuscular: '薄明性', always: '常時' }[a];
}

function h(tag: string, text: string, cls?: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function p(cls: string, text: string): HTMLElement {
  return h('div', text, cls);
}
function bar(label: string, value: number, color: string, dominant: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'stat-row';
  const l = document.createElement('span');
  l.className = 'stat-label';
  l.textContent = dominant ? `★${label}` : label;
  const track = document.createElement('div');
  track.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  fill.style.background = color;
  track.appendChild(fill);
  row.append(l, track);
  return row;
}
