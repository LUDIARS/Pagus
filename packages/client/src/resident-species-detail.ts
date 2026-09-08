import type { ShapePart, Vec3 } from './mesh-primitives.js';

/** Species-specific facial planes, feather layers and fur markings. */
export function residentSpeciesDetail(species: string, fur: Vec3): ShapePart[] {
    const parts: ShapePart[] = [];
    const cream: Vec3 = [.96, .87, .71], dark: Vec3 = [.18, .12, .12];
    const add = (center: Vec3, radius: Vec3, color: Vec3): void => {
        parts.push({ center, radius, color, detail: true });
    };
    if (species === '梟') {
        for (const side of [-1, 1]) {
            add([side * .18, 1.20, .265], [.195, .21, .06], cream);
            for (let feather = 0; feather < 5; feather++) {
                add([side * (.33 + feather * .025), .73 - feather * .065, .07], [.10, .17, .055],
                    feather % 2 ? fur : [.45, .39, .33]);
            }
        }
    } else if (species === '蛇') {
        for (let i = 0; i < 5; i++) add([0, 1.0 + i * .045, .31], [.23 - i * .018, .016, .022], cream);
        add([0, 1.02, .40], [.018, .045, .065], [.65, .12, .16]);
    } else {
        for (const side of [-1, 1]) {
            add([side * .095, 1.025, .36], [.10, .085, .05], cream);
            add([side * .16, 1.32, .29], [.10, .026, .025], dark);
            for (let i = 0; i < 3; i++) {
                add([side * (.27 + i * .035), 1.03 - i * .018, .275], [.075, .038, .035], fur);
                add([side * (.085 + i * .04), 1.045, .406], [.009, .01, .005], dark);
            }
        }
        add([0, .975, .38], [.065, .012, .014], dark);
        if (species === '兎') for (const side of [-1, 1])
            add([side * .027, .96, .39], [.023, .036, .017], [.99, .97, .86]);
    }
    return parts;
}
