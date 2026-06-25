// アニメ吹き出し。1 文字ずつ表示 (タイプライタ) + 文字に波。
// tone='angry' は文字を大きく・赤く・速い大波 + ボックスをシェイクする。
// 毎フレーム tick(dtMs) で自走し、寿命が尽きると done=true になる。

import { Container, Graphics, Text } from 'pixi.js';

export type BubbleTone = 'calm' | 'angry';

interface ToneCfg {
  fontSize: number;
  fill: number;
  bg: number;
  stroke: number;
  cps: number; // 1 秒あたり表示文字数
  waveAmp: number;
  waveSpeed: number;
  shake: number;
}

const CALM: ToneCfg = { fontSize: 14, fill: 0x241a10, bg: 0xf6eccb, stroke: 0xb89a5a, cps: 20, waveAmp: 1.6, waveSpeed: 4, shake: 0 };
const ANGRY: ToneCfg = { fontSize: 19, fill: 0x6e0a0a, bg: 0xffd6c4, stroke: 0x8a1a1a, cps: 34, waveAmp: 3.6, waveSpeed: 15, shake: 2.4 };

/** 色だけ差し替える上書き (プレイヤーの吹き出しを村人と区別する用)。 */
export interface BubbleColors {
  fill?: number;
  bg?: number;
  stroke?: number;
}

interface Glyph {
  t: Text;
  baseY: number;
}

export class AnimatedBubble {
  readonly node = new Container();
  private readonly inner = new Container();
  private readonly bg = new Graphics();
  private readonly glyphs: Glyph[] = [];
  private readonly cfg: ToneCfg;
  private revealed = 0;
  private time = 0;
  private heldMs = 0;
  done = false;

  constructor(text: string, tone: BubbleTone = 'calm', holdMs = 1700, colors?: BubbleColors) {
    const base = tone === 'angry' ? ANGRY : CALM;
    this.cfg = colors
      ? {
          ...base,
          fill: colors.fill ?? base.fill,
          bg: colors.bg ?? base.bg,
          stroke: colors.stroke ?? base.stroke,
        }
      : base;
    this.holdMs = holdMs;
    this.node.addChild(this.bg, this.inner);

    const chars = [...text];
    let x = 0;
    for (const ch of chars) {
      const t = new Text({
        text: ch,
        style: { fontSize: this.cfg.fontSize, fill: this.cfg.fill, fontWeight: tone === 'angry' ? 'bold' : 'normal' },
      });
      t.anchor.set(0, 0.5);
      t.visible = false;
      t.x = x;
      this.inner.addChild(t);
      this.glyphs.push({ t, baseY: 0 });
      x += t.width;
    }
    const total = x;

    const pad = 9;
    const tail = 8;
    const bw = total + pad * 2;
    const bh = this.cfg.fontSize + pad * 2 + this.cfg.waveAmp * 2;
    const cy = -bh / 2 - tail;
    if (tone === 'angry') {
      // とげとげの糾弾フキダシ。
      this.drawSpiky(0, cy, bw / 2 + 8, bh / 2 + 8);
      this.bg.moveTo(-7, -tail).lineTo(7, -tail).lineTo(0, 0).fill(this.cfg.bg);
      this.bg.stroke({ width: 2, color: this.cfg.stroke });
    } else {
      this.bg.roundRect(-bw / 2, -bh - tail, bw, bh, 7).fill(this.cfg.bg);
      this.bg.moveTo(-6, -tail).lineTo(6, -tail).lineTo(0, 0).fill(this.cfg.bg);
    }

    for (let i = 0; i < this.glyphs.length; i++) {
      const g = this.glyphs[i];
      if (!g) continue;
      g.t.x = -total / 2 + g.t.x;
      g.baseY = cy;
      g.t.y = cy;
    }
  }

  private drawSpiky(cx: number, cy: number, rx: number, ry: number): void {
    const spikes = 14;
    const pts: number[] = [];
    for (let i = 0; i < spikes * 2; i++) {
      const ang = (Math.PI * i) / spikes;
      const r = i % 2 === 0 ? 1 : 0.82;
      pts.push(cx + Math.cos(ang) * rx * r, cy + Math.sin(ang) * ry * r);
    }
    this.bg.poly(pts).fill(this.cfg.bg);
  }

  private readonly holdMs: number;

  tick(dtMs: number): void {
    this.time += dtMs / 1000;

    const target = Math.min(this.glyphs.length, Math.floor(this.time * this.cfg.cps));
    for (; this.revealed < target; this.revealed++) {
      const g = this.glyphs[this.revealed];
      if (g) g.t.visible = true;
    }
    for (let i = 0; i < this.revealed; i++) {
      const g = this.glyphs[i];
      if (g) g.t.y = g.baseY + Math.sin(this.time * this.cfg.waveSpeed + i * 0.6) * this.cfg.waveAmp;
    }
    if (this.cfg.shake > 0) {
      this.inner.x = (Math.random() - 0.5) * this.cfg.shake;
      this.inner.y = (Math.random() - 0.5) * this.cfg.shake;
    }
    if (this.revealed >= this.glyphs.length) {
      this.heldMs += dtMs;
      if (this.heldMs > this.holdMs) {
        const fade = (this.heldMs - this.holdMs) / 400;
        this.node.alpha = Math.max(0, 1 - fade);
        if (fade >= 1) this.done = true;
      }
    }
  }

  destroy(): void {
    this.node.destroy({ children: true });
  }
}
