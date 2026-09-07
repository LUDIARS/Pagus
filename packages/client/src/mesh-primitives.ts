export type Vec3 = [
    number,
    number,
    number
];
export interface ShapePart {
    center: Vec3;
    radius: Vec3;
    color: Vec3;
    box?: boolean;
}
/** Triangulate coefficient primitives with a bounded, low-poly topology (position + color). */
export function triangulate(parts: ShapePart[]): Float32Array {
    const vertices: number[] = [];
    for (const p of parts) {
        const emit = (v: Vec3): void => { vertices.push(...v.map((x, i) => x * (p.radius[i] ?? 1) + (p.center[i] ?? 0)), ...p.color); };
        if (p.box) {
            const corners: Vec3[] = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
            for (const i of [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]) {
                const v = corners[i];
                if (v)
                    emit(v);
            }
            continue;
        }
        const point = (lat: number, lon: number): Vec3 => [Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)];
        for (let y = 0; y < 6; y++)
            for (let x = 0; x < 10; x++) {
                const a = y * Math.PI / 6, b = (y + 1) * Math.PI / 6, c = x * Math.PI / 5, d = (x + 1) * Math.PI / 5;
                for (const v of [point(a, c), point(b, c), point(b, d), point(a, c), point(b, d), point(a, d)])
                    emit(v);
            }
    }
    return new Float32Array(vertices);
}
