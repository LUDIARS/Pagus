import { TOWN_AREAS, townAreaAt, type TownArea, type ServerMessage, type WireWorld } from '@pagus/sim';
import type { StageView } from './stage-view.js';

const AREA_LABELS = ['北西住宅地', '北部', '北東住宅地', '西部', '噴水広場', '東部', '南西郊外', '南部', '南東郊外'];
/** Matches the server-side area-stream filter: dead and 神隠し residents are not drawn. */
function visibleResidents(world: WireWorld): WireWorld['villagers'] {
  return world.villagers.filter((v) => v.alive && (v.hiddenUntilTerm ?? -1) <= world.term);
}

/** Subscription lifetime is the page lifetime; reconnect explicitly resubscribes. */
export class AreaView {
  private area: TownArea = 'plaza';
  private sequence = -1;
  private chosen = false;
  private court = false;
  private previousArea: TownArea = 'plaza';
  private world: WireWorld | null = null;
  private readonly select = document.createElement('select');
  private readonly find = document.createElement('button');
  constructor(private readonly stage: StageView, private readonly subscribe: (area: TownArea) => void) {
    const select = this.select;
    select.setAttribute('aria-label', '閲覧エリア');
    TOWN_AREAS.forEach((area, i) => select.add(new Option(AREA_LABELS[i] ?? area, area)));
    select.value = this.area;
    select.onchange = () => {
      this.chosen = true;
      this.switchTo(TOWN_AREAS[select.selectedIndex] ?? 'plaza');
    };
    stage.addAreaControl(select);
    this.find.type = 'button';
    this.find.textContent = '住民のいる場所へ';
    this.find.disabled = true;
    this.find.onclick = () => { if (this.world) this.jumpTo(this.countByArea(this.world)); };
    stage.addAreaControl(this.find);
  }
  update(world: WireWorld): void {
    this.world = world;
    const court = !!world.trial?.factions && ['ten', 'ketsu', 'reform'].includes(world.phase);
    this.select.disabled = court;
    if (court !== this.court) {
      if (court) this.previousArea = this.area;
      this.court = court;
      const target = court ? 'plaza' : this.previousArea;
      this.stage.transitionScene(() => { this.switchTo(target); this.stage.resetCamera(); });
    }
    if (court) { this.find.disabled = true; return; }
    const counts = this.countByArea(world);
    let total = 0;
    TOWN_AREAS.forEach((area, i) => {
      const count = counts.get(area) ?? 0;
      total += count;
      const option = this.select.options[i];
      if (option) option.textContent = `${AREA_LABELS[i] ?? area} (${count}人)`;
    });
    this.find.disabled = total === 0;
    // Only the very first populated snapshot may move the camera on its own; once the
    // viewer has picked an area (or the button has picked one for them) we never follow.
    if (!this.chosen && total) this.jumpTo(counts);
  }
  private countByArea(world: WireWorld): Map<TownArea, number> {
    const counts = new Map<TownArea, number>(TOWN_AREAS.map((area) => [area, 0]));
    for (const v of visibleResidents(world)) {
      const area = townAreaAt(world.config, v.position);
      counts.set(area, (counts.get(area) ?? 0) + 1);
    }
    return counts;
  }
  private jumpTo(counts: Map<TownArea, number>): void {
    const next = [...TOWN_AREAS].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0];
    if (!next || !counts.get(next)) return;
    this.chosen = true;
    // setArea() re-centres the camera itself, but only when the area actually changes;
    // re-picking the current area still has to reframe it.
    if (next === this.area) this.stage.resetCamera();
    else this.switchTo(next);
  }
  private switchTo(area: TownArea): void {
    this.area = area;
    this.select.value = area;
    this.sequence = -1;
    this.stage.clearResidents();
    this.stage.setArea(area);
    this.subscribe(area);
  }
  reconnect(): void { this.sequence = -1; this.stage.clearResidents(); this.subscribe(this.area); }
  accept(frame: Extract<ServerMessage, { t: 'areaFrame' }>): boolean {
    if (frame.area !== this.area || frame.sequence <= this.sequence) return false;
    this.sequence = frame.sequence;
    return true;
  }
}
