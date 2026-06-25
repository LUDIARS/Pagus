// 村の評判 (徳目6軸) レーダーチャート。2D canvas で描画。

import { VIRTUES, VIRTUE_LABELS } from '@pagus/sim';
import type { VirtueVector } from '@pagus/sim';

function vertex(cx: number, cy: number, r: number, i: number, n: number): [number, number] {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

export class Radar {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context を取得できません');
    this.ctx = ctx;
  }

  update(rep: VirtueVector): void {
    const { ctx } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 30;
    const n = VIRTUES.length;
    ctx.clearRect(0, 0, W, H);

    // 同心リング
    ctx.strokeStyle = '#2a3346';
    for (let ring = 1; ring <= 3; ring += 1) {
      ctx.beginPath();
      for (let i = 0; i < n; i += 1) {
        const [x, y] = vertex(cx, cy, (R * ring) / 3, i, n);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    // 軸 + ラベル
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [i, key] of VIRTUES.entries()) {
      const [x, y] = vertex(cx, cy, R, i, n);
      ctx.strokeStyle = '#2a3346';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
      const [lx, ly] = vertex(cx, cy, R + 16, i, n);
      ctx.fillStyle = '#9fb0cc';
      ctx.fillText(VIRTUE_LABELS[key], lx, ly);
    }

    // 値ポリゴン
    ctx.beginPath();
    for (const [i, key] of VIRTUES.entries()) {
      const val = Math.max(0, Math.min(1, rep[key]));
      const [x, y] = vertex(cx, cy, R * val, i, n);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(86, 204, 242, 0.35)';
    ctx.strokeStyle = '#56ccf2';
    ctx.fill();
    ctx.stroke();
  }
}
