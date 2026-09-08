import type { MixedPart } from '@pagus/sim';
import type { ShapePart, Vec3 } from './mesh-primitives.js';

/** Exterior only. Brick courses and flat-roof boxes share the same lot footprint. */
export function homeModel(id: string, origin: Vec3, scale: number, mutations: readonly MixedPart[]): ShapePart[] {
  const parts: ShapePart[] = [];
  const add = (x: number, y: number, z: number, rx: number, ry: number, rz: number, color: Vec3, box = true): void => {
    parts.push({ center: [origin[0] + x * scale, y, origin[2] + z * scale], radius: [rx * scale, ry, rz * scale], color, box });
  };
  const variant = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 2;
  if (variant === 0) {
    add(0, .15, 0, .85, 1.15, .85, [.68, .34, .23], false);
    for (let row = 0; row < 4; row++) {
      const radius = Math.sqrt(1 - (row / 5) ** 2) * .82;
      for (let i = 0; i < 10; i++) {
        const angle = (i + row % 2 * .5) * Math.PI / 5;
        add(Math.cos(angle) * radius, .2 + row * .22, Math.sin(angle) * radius, .12, .085, .10,
          i % 2 ? [.78, .43, .3] : [.61, .29, .21]);
      }
    }
  } else {
    add(0, .58, 0, .78, .58, .72, [.82, .85, .85]);
    add(0, 1.2, 0, .87, .07, .81, [.29, .34, .39]);
    add(-.28, .85, .74, .36, .2, .025, [.24, .49, .61]);
    add(.45, 1.45, -.3, .22, .22, .28, [.58, .65, .7]);
  }
  add(.25, .35, .78, .19, .35, .04, [.27, .21, .17]);
  mutations.slice(0, 8).forEach((part, i) => {
    const x = (i % 3 - 1) * .46, y = 1.4 + Math.floor(i / 3) * .5;
    switch (part) {
      case 'eyes':
        add(x, y, .2, .25, .23, .18, [.93, .9, .68], false);
        add(x, y, .37, .08, .13, .03, [.13, .2, .18], false); break;
      case 'clockwork':
        add(x, y, 0, .26, .26, .22, [.64, .5, .25]);
        for (const dx of [-.3, .3]) add(x + dx, y, 0, .07, .12, .12, [.35, .39, .4]); break;
      case 'teapot':
        add(x, y, 0, .28, .25, .25, [.76, .54, .39], false);
        add(x + .3, y + .1, 0, .18, .08, .08, [.76, .54, .39]); break;
      case 'hybrid': add(x, y, 0, .3, .3, .3, [.49, .55, .7]); break;
      case 'slime': add(x, y, .2, .34, .32, .3, [.36, .73, .51], false); break;
      case 'extraArms':
        for (const side of [-1, 1]) {
          add(x + side * .24, y, 0, .22, .09, .1, [.66, .52, .4]);
          add(x + side * .4, y + .15, 0, .08, .2, .1, [.66, .52, .4]);
          add(x + side * .4, y + .35, 0, .12, .09, .13, [.66, .52, .4], false);
        }
        break;
      default:
        for (let j = 0; j < 4; j++) add(x + Math.sin(j * 1.1) * .14, y + j * .14, .2 + j * .08,
          .14 - j * .025, .12, .13 - j * .02, part === 'cthulhu' ? [.24, .44, .37] : [.58, .42, .63], false);
    }
  });
  return parts;
}
