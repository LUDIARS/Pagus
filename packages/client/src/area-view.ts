import { TOWN_AREAS, type TownArea, type ServerMessage } from '@pagus/sim';
import type { StageView } from './stage-view.js';

/** Subscription lifetime is the page lifetime; reconnect explicitly resubscribes. */
export class AreaView {
  private area: TownArea = 'plaza';
  private sequence = -1;
  constructor(private readonly stage: StageView, private readonly subscribe: (area: TownArea) => void) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', '閲覧エリア');
    const labels = ['北西住宅地', '北部', '北東住宅地', '西部', '噴水広場', '東部', '南西郊外', '南部', '南東郊外'];
    TOWN_AREAS.forEach((area, i) => select.add(new Option(labels[i] ?? area, area)));
    select.value = this.area;
    select.onchange = () => {
      this.area = TOWN_AREAS[select.selectedIndex] ?? 'plaza';
      this.sequence = -1;
      stage.clearResidents();
      this.subscribe(this.area);
    };
    stage.addAreaControl(select);
  }
  reconnect(): void { this.sequence = -1; this.stage.clearResidents(); this.subscribe(this.area); }
  accept(frame: Extract<ServerMessage, { t: 'areaFrame' }>): boolean {
    if (frame.area !== this.area || frame.sequence <= this.sequence) return false;
    this.sequence = frame.sequence;
    return true;
  }
}
