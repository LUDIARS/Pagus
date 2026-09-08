import type { Vec3 } from './mesh-primitives.js';

/** Flatten the civic centre; gentle asymmetric hills give the outskirts relief. */
export function terrainHeight(x: number, z: number): number {
  const edge = Math.max(0, Math.min(1, (Math.hypot(x, z) - 5) / 11));
  const smooth = edge * edge * (3 - 2 * edge);
  return smooth * (.38 + .48 * Math.sin(x * .13) * Math.cos(z * .11) + .22 * Math.sin(z * .23));
}

/** Continuous triangles instead of stacked ground boxes; no extra GPU allocation. */
export function terrainVertices(): Float32Array {
  const out: number[] = [];
  for (let z = -20; z < 20; z++) for (let x = -20; x < 20; x++) {
    const points: Vec3[] = [[x, terrainHeight(x,z)-.045, z], [x+1,terrainHeight(x+1,z)-.045,z],
      [x+1,terrainHeight(x+1,z+1)-.045,z+1], [x,terrainHeight(x,z+1)-.045,z+1]];
    const shade = .025 * Math.sin(x * .7 + z * .3);
    for (const i of [0,2,1,0,3,2]) out.push(...points[i]!, .43+shade,.59+shade,.39+shade);
  }
  return new Float32Array(out);
}
