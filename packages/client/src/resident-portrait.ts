import type { Villager } from '@pagus/sim';
import { residentParts, triangulate, type ShapePart } from './resident-mesh.js';

/** Static projection of the actual town mesh, without a WebGL context per row. */
function renderPortrait(parts: ShapePart[]): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 160;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('住民モデルのプレビューには Canvas 2D が必要です。');
  const vertices = triangulate(parts);
  const triangles: { points: number[][]; depth: number; color: string }[] = [];
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (let i = 0; i < vertices.length; i += 18) {
    const points: number[][] = [];
    let depth = 0;
    for (let j = 0; j < 3; j++) {
      const offset = i + j * 6;
      const x = vertices[offset] ?? 0, y = vertices[offset + 1] ?? 0, z = vertices[offset + 2] ?? 0;
      const xx = Math.cos(-.35) * x - Math.sin(-.35) * z;
      const zz = Math.sin(-.35) * x + Math.cos(-.35) * z;
      const yy = -(y * .866 - zz * .5);
      points.push([xx, yy]);
      depth += zz * .866 + y * .5;
      left = Math.min(left, xx); right = Math.max(right, xx);
      top = Math.min(top, yy); bottom = Math.max(bottom, yy);
    }
    const a = [0, 1, 2].map((axis) => (vertices[i + 6 + axis] ?? 0) - (vertices[i + axis] ?? 0));
    const b = [0, 1, 2].map((axis) => (vertices[i + 12 + axis] ?? 0) - (vertices[i + axis] ?? 0));
    const normal = [(a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0), (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0), (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0)];
    const light = .5 + .5 * Math.abs((-(normal[0] ?? 0) * .4 + (normal[1] ?? 0) * .8 + (normal[2] ?? 0) * .5) / (Math.hypot(...normal) * Math.sqrt(1.05) || 1));
    const rgb = [3, 4, 5].map((channel) => Math.round((vertices[i + channel] ?? 0) * light * 255));
    triangles.push({ points, depth, color: `rgb(${rgb.join(',')})` });
  }
  const scale = 140 / Math.max(right - left, bottom - top, .01);
  ctx.fillStyle = '#e9eee6'; ctx.fillRect(0, 0, 160, 160);
  for (const triangle of triangles.sort((a, b) => b.depth - a.depth)) {
    ctx.beginPath();
    triangle.points.forEach(([x = 0, y = 0], i) => {
      const px = 80 + (x - (left + right) / 2) * scale, py = 80 + (y - (top + bottom) / 2) * scale;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath(); ctx.fillStyle = triangle.color; ctx.fill();
  }
  return canvas.toDataURL('image/png');
}

/** Owns lazy observation and a bounded cache, retained across roster refreshes. */
export class ResidentPortraits {
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<HTMLImageElement, ShapePart[]>();
  private readonly observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target as HTMLImageElement;
      this.observer.unobserve(img);
      const parts = this.pending.get(img);
      this.pending.delete(img);
      if (parts) this.paint(img, JSON.stringify(parts), parts);
    }
  });

  /** Draw from cache when possible so a re-render never depends on a fresh observer callback. */
  private paint(img: HTMLImageElement, key: string, parts: ShapePart[]): void {
    try {
      let data = this.cache.get(key);
      if (!data) { data = renderPortrait(parts); this.cache.set(key, data); }
      img.src = data;
      while (this.cache.size > 128) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    } catch (error) {
      img.alt = error instanceof Error ? error.message : 'モデルを表示できません';
    }
  }

  reset(): void { this.observer.disconnect(); this.pending.clear(); }
  create(v: Villager): HTMLImageElement {
    const img = document.createElement('img');
    img.width = img.height = 80;
    img.alt = `${v.name}の現在のモデル（教育${v.reformCount}回）`;
    img.style.cssText = 'float:left;margin:0 10px 4px 0;border-radius:8px;object-fit:contain';
    const parts = residentParts(v);
    const key = JSON.stringify(parts);
    // Snapshots re-render this list often; without a synchronous cache hit the rows would
    // be discarded and re-observed before the observer ever fired, so nothing would paint.
    if (this.cache.has(key)) {
      this.paint(img, key, parts);
      return img;
    }
    this.pending.set(img, parts);
    this.observer.observe(img);
    return img;
  }
  destroy(): void { this.reset(); this.cache.clear(); }
}
