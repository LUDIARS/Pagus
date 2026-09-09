import { HOUSING_NAMES, townMap, townSite, type WireWorld } from '@pagus/sim';
import { townPoint } from './town-coordinates.js';
import type { PictorScene } from './pictor-scene.js';
import type { Vec3 } from './mesh-primitives.js';
import type { TownArea } from '@pagus/sim';
import { townViewSites } from './town-view-sites.js';

/** Building selection exposes occupancy and jobs. Owns its DOM and event handlers. */
export class TownLabels {
  readonly root = document.createElement('div');
  readonly detail = document.createElement('div');
  private selected = 'fountain';
  private signature = '';
  private labels = new Map<string, HTMLButtonElement>();
  onFocus: ((position: Vec3) => void) | null = null;
  constructor() {
    this.root.className = 'town-labels';
    this.detail.className = 'town-detail';
    this.detail.setAttribute('aria-live', 'polite');
  }
  update(world: WireWorld, area: TownArea, radius: 1 | 2 = 1): void {
    const map = townMap(world.config);
    const sites = townViewSites(world.config, area, radius);
    const signature = `${map.width}:${map.height}:${area}:${radius}`;
    if (!sites.some((site) => site.id === this.selected)) this.selected = sites[0]?.id ?? 'fountain';
    if (signature !== this.signature) {
      this.clear();
      this.signature = signature;
      for (const site of sites) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset['kind'] = site.kind;
        this.labels.set(site.id, button);
        this.root.append(button);
      }
    }
    for (const site of sites) {
      const button = this.labels.get(site.id)!;
      const residents = world.villagers.filter((v) => v.alive && v.townLife?.homeId === site.id);
      const former = world.villagers.find((v) => v.townLife?.formerHomeId === site.id);
      button.textContent = site.kind === 'home' ? residents.map((v) => v.name).join('・') || (former ? `${former.name}の家（${former.townLife?.housing === 'displaced' ? '損壊' : '留守'}）` : '空き家') : site.name;
      button.title = site.name;
      const building = world.villagers.find((v) => v.alive && v.townLife?.buildHomeId === site.id);
      if (building) button.textContent = `${building.name}の家（建設 ${building.townLife?.buildProgress ?? 0}/4）`;
      button.onclick = () => { this.selected = site.id; this.update(world, area, radius); this.onFocus?.(townPoint(world.config, site.position)); };
    }
    const site = townSite(map, this.selected);
    const workers = world.villagers.filter((v) => v.alive && (v.townLife?.occupation === site.id || (site.id === 'hunting' && v.townLife?.occupation === 'hunter')));
    const residents = world.villagers.filter((v) => v.alive && v.townLife?.homeId === site.id);
    const title = document.createElement('strong');
    title.textContent = `${site.name} · ${String(Math.floor(world.calendar.segment / world.config.segmentsPerDay * 24)).padStart(2, '0')}:00`;
    const description = document.createElement('p');
    description.textContent = [workers.length ? `働く人：${workers.map((v) => v.name).join('・')}` : '', ...residents.map((v) => `${v.name}：${HOUSING_NAMES[v.townLife!.housing]}。${v.townLife!.reason}`)].filter(Boolean).join('\n') || (site.kind === 'fountain' ? '街の中心。仕事帰りに集い、事件の証言と裁判もこの広場で交わされる。' : site.kind === 'home' ? '新しく定住する住民を待つ家。' : '建物を選ぶと、そこで暮らす人・働く人を確認できます。');
    this.detail.replaceChildren(title, description);
  }
  project(renderer: PictorScene, world: WireWorld): void {
    for (const site of townMap(world.config).sites) {
      const p = townPoint(world.config, site.position);
      p[1] += site.kind === 'inn' ? 2.6 : 1.9;
      const screen = renderer.project(p);
      const button = this.labels.get(site.id);
      if (button) button.style.transform = `translate(${screen.x}px,${screen.y}px) translate(-50%,-50%)`;
    }
  }
  clear(): void { this.root.replaceChildren(); this.labels.clear(); this.signature = ''; }
  destroy(): void { this.clear(); this.onFocus = null; this.root.remove(); this.detail.remove(); }
}
