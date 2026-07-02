// スコアボード UI (§4)。プレイヤー一覧 (称号・陣営・カルマ・善性・主要 stats)、
// 二大陣営 (善導 vs 扇動) の綱引きバー、陣営選択ボタンを表示する。

import type { LeaderboardView } from './ws-client.js';

const FACTION_LABEL: Record<'guide' | 'incite', string> = { guide: '善導', incite: '扇動' };

export class LeaderboardPanel {
  private view: LeaderboardView | null = null;

  private readonly tugBox = document.createElement('div');
  private readonly listBox = document.createElement('div');

  constructor(
    private readonly root: HTMLElement,
    private readonly myUserId: string,
    private readonly sendFaction?: (side: 'guide' | 'incite') => void,
  ) {
    this.root.replaceChildren();
    const head = document.createElement('h3');
    head.textContent = '🏆 スコアボード';
    this.root.appendChild(head);

    // 二大陣営の綱引きバー (§4.3)。
    this.root.appendChild(subLabel('二大陣営の旗色 (村の徳目綱引き)'));
    this.tugBox.className = 'faction-tug';
    this.root.appendChild(this.tugBox);

    // 陣営選択ボタン。
    if (this.sendFaction) {
      const btns = document.createElement('div');
      btns.className = 'faction-btns';
      btns.append(
        this.factionButton('🕊 善導につく', 'guide', 'faction-guide'),
        this.factionButton('🔥 扇動につく', 'incite', 'faction-incite'),
      );
      this.root.appendChild(btns);
    }

    this.root.appendChild(subLabel('プレイヤー'));
    this.listBox.className = 'lb-list';
    this.root.appendChild(this.listBox);

    this.render();
  }

  setLeaderboard(v: LeaderboardView): void {
    this.view = v;
    this.render();
  }

  private factionButton(text: string, side: 'guide' | 'incite', cls: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.className = cls;
    btn.addEventListener('click', () => this.sendFaction?.(side));
    return btn;
  }

  private render(): void {
    const v = this.view;
    // 綱引きバー。
    this.tugBox.replaceChildren();
    const guide = v?.factions.guide ?? 0;
    const incite = v?.factions.incite ?? 0;
    const total = guide + incite;
    const guidePct = total > 0 ? Math.round((guide / total) * 100) : 50;
    const bar = document.createElement('div');
    bar.className = 'tug-bar';
    const gFill = document.createElement('i');
    gFill.className = 'tug-guide';
    gFill.style.width = `${guidePct}%`;
    const iFill = document.createElement('i');
    iFill.className = 'tug-incite';
    iFill.style.width = `${100 - guidePct}%`;
    bar.append(gFill, iFill);
    this.tugBox.appendChild(bar);
    const legend = document.createElement('div');
    legend.className = 'tug-legend';
    legend.textContent = `🕊 善導 ${guide}  ／  扇動 ${incite} 🔥`;
    this.tugBox.appendChild(legend);

    // プレイヤー一覧 (カルマ降順)。
    this.listBox.replaceChildren();
    const players = [...(v?.players ?? [])].sort((a, b) => b.karma - a.karma);
    if (players.length === 0) {
      this.listBox.appendChild(hint('まだプレイヤーがいません'));
      return;
    }
    for (const p of players) {
      const row = document.createElement('div');
      row.className = 'lb-row';
      const isMe = p.userId === this.myUserId;
      if (isMe) row.classList.add('lb-me');

      const top = document.createElement('div');
      top.className = 'lb-top';
      const name = document.createElement('span');
      name.className = 'lb-name';
      name.textContent = p.userName ?? (isMe ? 'あなた' : shortId(p.userId));
      const tags = document.createElement('span');
      tags.className = 'lb-tags';
      const factionTag = FACTION_LABEL[p.faction];
      tags.textContent = p.title ? `${p.title}・${factionTag}` : factionTag;
      top.append(name, tags);
      row.appendChild(top);

      const meta = document.createElement('div');
      meta.className = 'lb-meta';
      meta.textContent =
        `💠${p.karma.toFixed(0)} 😇${p.virtue.toFixed(2)} 💴¥${p.spent} ` +
        `🔥${p.stats.incites} ⚖${p.stats.sanctions} 🌸${p.stats.cheers} 📜${p.stats.rulesAdded} 🎲${p.stats.betsWon}`;
      row.appendChild(meta);
      this.listBox.appendChild(row);
    }
  }
}

/** userId を短く (先頭6文字)。 */
function shortId(id: string): string {
  return id.length > 6 ? `${id.slice(0, 6)}…` : id;
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
