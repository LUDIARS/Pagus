import type { TownSite, MixedPart } from '@pagus/sim';
import { homeModel } from './home-model.js';
import type { ShapePart, Vec3 } from './mesh-primitives.js';

const ROOFS: Partial<Record<TownSite['kind'], Vec3>> = { doctor: [.65, .34, .33], general: [.32, .54, .53], carpenter: [.53, .37, .25], tailor: [.57, .39, .65], grocer: [.4, .59, .27], diner: [.79, .43, .24], inn: [.29, .39, .56], isolation: [.37, .4, .37] };
/** Storefront silhouettes stay within the solid map cell; doors face south. */
export function townBuilding(site: TownSite, origin: Vec3, halfCell: number, damaged = false, mutations: readonly MixedPart[] = []): ShapePart[] {
  const parts: ShapePart[] = [];
  const add = (x: number, y: number, z: number, rx: number, ry: number, rz: number, color: Vec3, box = true): void => {
    parts.push({ center: [origin[0] + x * halfCell, y, origin[2] + z * halfCell], radius: [rx * halfCell, ry, rz * halfCell], color, box });
  };
  const wood: Vec3 = [.4, .28, .2];
  if (damaged) {
    add(0, .12, 0, .8, .15, .72, [.31, .29, .27]);
    for (const x of [-.6, .6]) add(x, .5, -.4, .1, .5, .12, [.24, .23, .21]);
    add(0, .28, .35, .55, .16, .3, [.48, .41, .32], false);
    return parts;
  }
  if (site.kind === 'hunting') {
    for (const [x, z] of [[-.7, -.6], [.7, -.6], [0, .5]] as const) {
      add(x, .65, z, .12, .7, .12, wood);
      add(x, 1.65, z, .6, .95, .6, [.22, .4, .3], false);
    }
    return parts;
  }
  if (site.kind === 'shelter') {
    add(0, .42, 0, .8, .5, .7, [.66, .59, .39], false);
    add(0, .3, .6, .3, .3, .08, wood);
    add(.6, .06, .8, .2, .06, .2, [.83, .42, .2], false);
    return parts;
  }
  if (site.kind === 'fountain') {
    add(0, .14, 0, .95, .2, .95, [.75, .76, .7], false);
    add(0, .31, 0, .79, .04, .79, [.3, .68, .78], false);
    add(0, .7, 0, .17, .45, .17, [.85, .83, .72], false);
    add(0, 1.12, 0, .48, .13, .48, [.78, .79, .72], false);
    add(0, 1.55, 0, .09, .42, .09, [.64, .9, .96], false);
    return parts;
  }
  if (site.kind === 'home') return homeModel(site.id, origin, halfCell, mutations);
  const home = site.kind === 'isolation';
  const height = site.kind === 'inn' ? 2 : home ? 1.05 : 1.3;
  const roof = ROOFS[site.kind] ?? [.63, .38, .3];
  add(0, height / 2, 0, .8, height / 2, .72, home ? [.86, .76, .57] : [.94, .84, .66]);
  add(0, height + .2, 0, .95, .38, .85, roof, false);
  add(0, .35, .74, .2, .35, .03, wood);
  for (const x of [-.49, .49]) add(x, .73, .75, .16, .18, .03, [.88, .84, .52]);
  add(.45, height + .42, -.3, .12, .3, .12, [.55, .5, .45]);
  if (home) return parts;
  add(0, 1, .83, .78, .08, .12, roof);
  add(.46, 1.54, .78, .25, .2, .05, [.96, .89, .73]);
  switch (site.kind) {
    case 'doctor':
      add(-.5, 1.8, -.3, .26, .55, .27, [.86, .88, .82]);
      add(.46, 1.54, .85, .06, .15, .02, [.74, .2, .23]);
      add(.46, 1.54, .85, .18, .05, .02, [.74, .2, .23]); break;
    case 'grocer':
      add(0, .95, .72, .9, .08, .25, [.36, .64, .25]);
      for (const x of [-.5, 0, .5]) { add(x, .2, .84, .2, .18, .1, wood); add(x, .42, .84, .19, .1, .1, x === 0 ? [.86, .3, .16] : [.4, .7, .3], false); } break;
    case 'carpenter':
      add(0, 1.35, .2, .94, .09, .6, wood);
      for (const x of [-.6, -.2, .2]) add(x, .22, .83, .15, .15, .1, [.66, .45, .26], false); break;
    case 'tailor':
      add(0, 1.95, 0, .42, .32, .4, [.65, .38, .63], false);
      add(.46, 1.54, .85, .18, .14, .02, [.7, .35, .66]); break;
    case 'diner':
      add(-.55, 1.7, -.4, .23, .8, .23, [.47, .36, .3]);
      add(.46, 1.54, .85, .19, .12, .02, [.65, .32, .17], false); break;
    case 'inn':
      for (const x of [-.49, .49]) add(x, 1.56, .75, .16, .18, .03, [.95, .8, .42]); break;
    case 'general':
      add(-.52, .55, .79, .28, .5, .13, [.36, .57, .56]);
      add(.46, 1.54, .85, .13, .13, .02, [.27, .53, .53]); break;
  }
  return parts;
}
