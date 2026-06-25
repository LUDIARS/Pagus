// 上部の暦/フェーズ表示と、右側のイベントログ。

import type { WireWorld, Phase, Season } from '@pagus/sim';

const SEASON_JA: Record<Season, string> = {
  spring: '春',
  summer: '夏',
  autumn: '秋',
  winter: '冬',
};

const PHASE_JA: Record<Phase, string> = {
  idle: '待機',
  kisho: '起',
  sho: '承',
  ten: '転',
  ketsu: '結',
  reform: '改変',
  advance: '日暮れ',
};

export class Hud {
  constructor(
    private readonly bar: HTMLElement,
    private readonly status: HTMLElement,
  ) {}

  updateCalendar(world: WireWorld): void {
    const c = world.calendar;
    const alive = world.villagers.filter((v) => v.alive).length;
    this.bar.textContent =
      `${c.year}年 ${c.month}月${c.dayOfMonth}日 (${SEASON_JA[c.season]}) ` +
      `時間帯 ${c.segment + 1}/${world.config.segmentsPerDay} ｜ ${PHASE_JA[world.phase]} ｜ ${alive}匹`;
  }

  setStatus(status: string): void {
    this.status.textContent = status;
  }
}
