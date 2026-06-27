// 右パネル: 村のステータス (徳目6軸) + 同時接続プレイヤー数 + 投票結果。
// players は WS の 'players' メッセージで、それ以外は snapshot で更新される。

import { VIRTUES, VIRTUE_LABELS } from '@pagus/sim';
import type { WireWorld, Virtue } from '@pagus/sim';

const VIRTUE_COLOR: Record<Virtue, string> = {
  benevolence: '#6fcf97',
  malice: '#eb5757',
  order: '#9b97f2',
  vitality: '#f2c94c',
  intellect: '#56ccf2',
  faith: '#f2994a',
};

export class VillageStatus {
  private world: WireWorld | null = null;
  private players = 0;

  constructor(private readonly root: HTMLElement) {}

  setPlayers(count: number): void {
    this.players = count;
    this.render();
  }

  update(world: WireWorld): void {
    this.world = world;
    this.render();
  }

  private render(): void {
    this.root.replaceChildren();
    this.root.appendChild(row('👥 接続プレイヤー', `${this.players} 人`));

    const w = this.world;
    if (!w) return;

    const alive = w.villagers.filter((v) => v.alive).length;
    this.root.appendChild(row('🐾 生存どうぶつ', `${alive} 匹`));

    this.root.appendChild(h('div', '村の評判 (徳目6軸)', 'sub'));
    for (const v of VIRTUES) {
      this.root.appendChild(bar(VIRTUE_LABELS[v], w.reputation[v], VIRTUE_COLOR[v]));
    }

    this.root.appendChild(h('div', '裁判 / 投票結果', 'sub'));
    const t = w.trial;
    if (!t) {
      this.root.appendChild(p('muted', '進行中の裁判はありません。'));
      return;
    }
    const nameOf = (id: string): string => w.villagers.find((x) => x.id === id)?.name ?? id;

    // 狂人の扇動を明示する。
    const madVote = t.votes.find((v) => v.voter === 'madman');
    if (madVote) {
      this.root.appendChild(p('verdict', `😈 狂人が扇動 (${nameOf(madVote.pick) || madVote.pick} へ +${madVote.weight})`));
    }

    if (Object.keys(t.foolishVotes).length > 0) {
      this.root.appendChild(p('muted', '最も愚かな行動:'));
      for (const [id, wsum] of Object.entries(t.foolishVotes).sort((a, b) => b[1] - a[1])) {
        this.root.appendChild(row(`　${nameOf(id)}`, `${wsum}`));
      }
    }
    if (t.fateVotes.kill > 0 || t.fateVotes.spare > 0) {
      this.root.appendChild(row('　死刑', `${t.fateVotes.kill}`));
      this.root.appendChild(row('　教育', `${t.fateVotes.spare}`));
    }
    if (t.verdict) {
      this.root.appendChild(
        p('verdict', `判決: ${t.verdict === 'death' ? '死刑（追放）' : '教育（改変）'}`),
      );
    }
  }
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
function row(label: string, value: string): HTMLElement {
  const r = document.createElement('div');
  r.className = 'kv';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'kv-val';
  v.textContent = value;
  r.append(l, v);
  return r;
}
function bar(label: string, value: number, color: string): HTMLElement {
  const r = document.createElement('div');
  r.className = 'stat-row';
  const l = document.createElement('span');
  l.className = 'stat-label';
  l.textContent = label;
  const track = document.createElement('div');
  track.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  fill.style.background = color;
  track.appendChild(fill);
  r.append(l, track);
  return r;
}
