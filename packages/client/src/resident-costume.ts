import type { ShapePart, Vec3 } from './mesh-primitives.js';

/** Tailored village clothing: waistcoat, shirt, seams, cuffs and boots. */
export function residentCostume(seed: number, species: string): ShapePart[] {
    const coats: Vec3[] = [[.24, .35, .46], [.46, .24, .20], [.28, .39, .28], [.40, .28, .44]];
    const coat = coats[seed % coats.length]!;
    const linen: Vec3 = [.93, .85, .68], leather: Vec3 = [.24, .16, .12];
    const parts: ShapePart[] = [];
    const add = (center: Vec3, radius: Vec3, color: Vec3, box = false): void => {
        parts.push({ center, radius, color, box, detail: true });
    };
    add([0, .55, 0], [.33, .37, .245], coat);
    add([0, .72, .22], [.115, .16, .035], linen);
    for (const side of [-1, 1]) {
        add([side * .14, .73, .225], [.068, .18, .045], coat);
        add([side * .09, .86, .24], [.078, .055, .035], linen);
        add([side * .20, .44, .23], [.072, .014, .022], linen, true);
        if (species !== '蛇' && species !== '梟') {
            add([side * .38, .50, 0], [.125, .065, .13], linen);
            add([side * .18, .12, .09], [.145, .13, .205], leather);
            add([side * .18, .035, .10], [.15, .028, .215], [.14, .10, .08]);
        }
    }
    for (const y of [.42, .53, .64]) add([0, y, .258], [.024, .025, .012], [.79, .63, .32]);
    return parts;
}
