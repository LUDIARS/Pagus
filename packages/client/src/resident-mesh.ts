import { mixedPartsFor, residentHeadSpecies, type Villager } from '@pagus/sim';
import { mutateAnatomy } from './resident-mutations.js';
import { residentCostume } from './resident-costume.js';
import { residentSpeciesDetail } from './resident-species-detail.js';
import type { ShapePart, Vec3 } from './mesh-primitives.js';
export type { ShapePart, Vec3 } from './mesh-primitives.js';
export { triangulate } from './mesh-primitives.js';
/** Figmentum-inspired coefficient anatomy: ellipsoids + independent attachments, rebuilt only on education. */
export function residentParts(v: Villager): ShapePart[] {
    const seed = [...v.id].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) >>> 0, 0);
    const palettes: Vec3[] = [[0.95, 0.65, 0.38], [0.66, 0.77, 0.91], [0.92, 0.72, 0.77], [0.74, 0.83, 0.59]];
    const fur: Vec3 = v.species === '蛇' ? [.58, .78, .48] : v.species === '熊' ? [.64, .45, .32] : palettes[seed % palettes.length] ?? [0.8, 0.7, 0.5];
    const cream: Vec3 = [1, 0.91, 0.74];
    const headSpecies = residentHeadSpecies(v);
    const headFur: Vec3 = headSpecies === v.species ? fur : headSpecies === '熊' ? [.64, .45, .32] : headSpecies === '蛇' ? [.48, .74, .39] : headSpecies === '梟' ? [.67, .79, .94] : [.94, .64, .35];
    const dark: Vec3 = [0.12, 0.12, 0.17];
    const mixed = mixedPartsFor(v);
    const hasClockwork = mixed.includes('clockwork');
    const hasBeast = mixed.includes('hybrid');
    const parts: ShapePart[] = [];
    const add = (center: Vec3, radius: Vec3, color: Vec3, box = false): void => { parts.push({ center, radius, color, box, detail: true }); };
    parts.push(...residentCostume(seed, v.species));
    add([0, 1.13, 0], [0.43, 0.39, 0.32], headFur);
    add([0, 1.03, 0.28], [0.26, 0.18, 0.13], cream);
    for (const side of [-1, 1]) {
        const rabbit = /兎|うさぎ|rabbit/.test(headSpecies);
        const owl = /梟|フクロウ|owl|鳥/.test(headSpecies);
        if (headSpecies !== '蛇' && !owl)
            add([side * 0.28, rabbit ? 1.64 : 1.43, 0], [headSpecies === '熊' ? .18 : 0.13, rabbit ? 0.36 : 0.18, 0.10], headFur);
        parts.push({ center: [side * .16, 1.19, .30], radius: [owl ? .13 : .085, owl ? .14 : .10, .065],
            color: hasBeast ? [.82, .035, .045] : dark, detail: true, preserveColor: true });
        if (!hasClockwork) parts.push({ center: [side * .16 - .02, 1.22, .354], radius: [.024, .03, .016], color: [1, 1, 1], detail: true, preserveColor: true });
        if (headSpecies !== '蛇' && !owl) add([side * .28, rabbit ? 1.64 : 1.44, .085], [.065, rabbit ? .25 : .095, .032], [.93, .58, .55]);
        add([side * .12, .89, .19], [.11, .075, .085], cream);
        for (let finger = 0; finger < 3 && v.species !== '蛇'; finger++)
            add([side * (.33 + finger * .045), .43, .08], [.035, .075, .065], cream);
        if (v.species !== '蛇') {
            add([side * 0.38, 0.62, 0], [v.species === '梟' ? .22 : 0.12, 0.24, 0.12], fur);
            add([side * 0.18, 0.14, 0.08], [0.14, 0.15, 0.20], fur);
        }
        if (v.species === '鼯鼠')
            add([side * .35, .54, -.04], [.27, .3, .07], [.75, .66, .57]);
        add([side * 0.28, 1.02, 0.30], [0.07, 0.045, 0.035], [0.96, 0.52, 0.49]);
    }
    add([0, 1.06, 0.40], headSpecies === '梟' ? [.1, .14, .13] : [0.065, 0.045, 0.04], headSpecies === '梟' ? [.94, .66, .26] : dark);
    if (v.species === '栗鼠')
        add([.32, .6, -.35], [.3, .53, .3], fur);
    else if (v.species === '蛇') {
        for (let i = 0; i < 7; i++)
            add([Math.sin(i * .6) * .35, .12, -i * .12], [.24 - i * .025, .13, .2], fur);
    }
    else
        add([0.26, 0.45, -0.28], [0.17, 0.24, 0.22], fur);
    for (const part of mixedPartsFor(v)) {
        if (part === 'tentacles') {
            for (const side of [-1, 1])
                for (let i = 0; i < 5; i++) {
                    add([side * (0.38 + i * 0.09), 0.64 - i * 0.08, 0.13 + Math.sin(i) * 0.09], [0.12 - i * 0.012, 0.11, 0.11 - i * 0.01], [0.42, 0.62, 0.55]);
                }
        }
        else if (part === 'eyes') {
            add([0, 1.42, 0.26], [0.16, 0.11, 0.08], [0.8, 0.61, 0.95]);
            add([0, 1.42, 0.33], [0.045, 0.085, 0.03], dark);
        }
        else if (part === 'teapot') {
            add([-0.43, 0.54, 0.05], [0.24, 0.25, 0.21], [0.96, 0.83, 0.9]);
            add([-0.67, 0.67, 0.05], [0.19, 0.08, 0.09], cream);
            add([-0.43, 0.8, 0.05], [0.16, 0.04, 0.15], [0.76, 0.54, 0.38]);
        }
        else if (part === 'clockwork') {
            add([0, 0.59, 0.27], [0.23, 0.23, 0.06], [0.86, 0.67, 0.28]);
            add([0, 0.65, 0.34], [0.025, 0.12, 0.02], dark, true);
            add([0.065, 0.58, 0.34], [0.09, 0.025, 0.02], dark, true);
            add([0, 1.65, -0.05], [0.18, 0.055, 0.055], [0.86, 0.67, 0.28], true);
        }
    }
    parts.push(...residentSpeciesDetail(headSpecies, headFur));
    // Body silhouette is species-specific while keeping education attachments intact.
    const width = v.species === '熊' ? 1.22 : v.species === '兎' ? .86 : v.species === '蛇' ? .82 : 1;
    const height = v.species === '兎' ? 1.10 : v.species === '熊' ? .96 : 1;
    const shaped = parts.map(part => ({ ...part,
        center: [part.center[0] * width, part.center[1] * height, part.center[2]] as Vec3,
        radius: [part.radius[0] * width, part.radius[1] * height, part.radius[2]] as Vec3,
    }));
    return mutateAnatomy(v, shaped).map(part => ({ ...part, detail: true }));
}
