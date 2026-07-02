// 村シーン: 2D トップダウン。
// - 暇な間: どうぶつは map をうろつく (client 側の装飾移動。裁判には無関係)。
// - 事件中: 加害者と被害者が現場に寄り、周りは逃げる/集まる。周囲は暗転。
// - 雑談/事件描写の吹き出しは say() で頭上に出す (タイプライタ表示)。

import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import { dominantAxis, isAwake, timeOfDayForSegment } from '@pagus/sim';
import type { WireWorld, PersonalityAxis, TimeOfDay } from '@pagus/sim';
import { animalFor, type AnimalName } from './assets.js';
import { AnimatedBubble, type BubbleTone } from './animated-bubble.js';
import { villagerDisplayName } from './villager-display.js';

const AXIS_COLOR: Record<PersonalityAxis, number> = {
  kindness: 0x6fcf97,
  aggression: 0xeb5757,
  sociability: 0xf2c94c,
  curiosity: 0x56ccf2,
  discipline: 0x9b97f2,
  ambition: 0xf2994a,
};

const TOD_BG: Record<TimeOfDay, number> = {
  night: 0x0d1b3e,
  morning: 0x9bbcd6,
  noon: 0xbfe3f0,
  evening: 0xe8a06b,
};

const WANDER_SPEED = 30; // px/s
const FOCUS_SPEED = 110; // px/s

type Role = 'idle' | 'perp' | 'victim' | 'flee' | 'gather';

interface Unit {
  node: Container;
  ring: Graphics;
  sprite: Sprite;
  label: Text;
  zzz: Text;
  bubble: AnimatedBubble | null;
  px: number;
  py: number;
  tx: number;
  ty: number;
  wanderMs: number;
  awake: boolean;
  role: Role;
  scatter: 'flee' | 'gather' | null;
}

export class VillageScene {
  readonly root = new Container();
  private readonly bg = new Graphics();
  private readonly grid = new Graphics();
  private readonly itemLayer = new Container();
  private readonly layer = new Container();
  private readonly vignette = new Graphics();
  private readonly units = new Map<string, Unit>();
  /** フィールドアイテム (§16) の表示ノード。id → 絵文字 Text。 */
  private readonly itemNodes = new Map<string, Text>();
  private w = 1;
  private h = 1;
  private cell = 24;
  private focusPerp: string | null = null;
  private focusSet = new Set<string>();
  private sceneCx = 0;
  private sceneCy = 0;
  private pulse = 0;

  constructor(private readonly tex: Map<AnimalName, Texture>) {
    this.layer.sortableChildren = true;
    // itemLayer は grid の上・どうぶつ (layer) の下に置く (落とし物は足元に見える)。
    this.root.addChild(this.bg, this.grid, this.itemLayer, this.layer, this.vignette);
  }

  awakeIds(world: WireWorld): string[] {
    return world.villagers
      .filter((v) => v.alive && isAwake(v.activity, world.calendar.segment, world.config.segmentsPerDay))
      .map((v) => v.id);
  }

  say(id: string, text: string, tone: BubbleTone = 'calm'): void {
    const u = this.units.get(id);
    if (!u) return;
    if (u.bubble) u.bubble.destroy();
    const b = new AnimatedBubble(text, tone);
    b.node.y = -this.cell * 0.75;
    u.node.addChild(b.node);
    u.bubble = b;
  }

  /** 事件フォーカス。null で解除し、散開判断をリセットする。 */
  setFocus(perpId: string | null, involved: Iterable<string> | null): void {
    if (perpId === null) {
      this.focusPerp = null;
      this.focusSet.clear();
      for (const u of this.units.values()) u.scatter = null;
      return;
    }
    if (this.focusPerp !== perpId) {
      // 新しい事件: 散開判断を引き直す。
      for (const u of this.units.values()) u.scatter = null;
      const perp = this.units.get(perpId);
      this.sceneCx = perp ? perp.px : this.w / 2;
      this.sceneCy = perp ? perp.py : this.h / 2;
    }
    this.focusPerp = perpId;
    this.focusSet = new Set(involved ?? []);
    this.focusSet.add(perpId);
  }

  tick(dtMs: number): void {
    const dt = dtMs / 1000;
    this.pulse += dt;
    const margin = this.cell * 1.5;
    for (const u of this.units.values()) {
      // 目標へ移動。
      const speed = u.role === 'idle' ? WANDER_SPEED : FOCUS_SPEED;
      if (u.role === 'idle' && u.awake) {
        u.wanderMs -= dtMs;
        if (u.wanderMs <= 0) {
          u.tx = margin + Math.random() * (this.w - margin * 2);
          u.ty = margin + Math.random() * (this.h - margin * 2);
          u.wanderMs = 1200 + Math.random() * 1800;
        }
      }
      const dx = u.tx - u.px;
      const dy = u.ty - u.py;
      const dist = Math.hypot(dx, dy);
      const step = speed * dt;
      if (dist > step && dist > 0.5) {
        u.px += (dx / dist) * step;
        u.py += (dy / dist) * step;
      } else {
        u.px = u.tx;
        u.py = u.ty;
      }
      u.node.x = u.px;
      u.node.y = u.py;

      if (u.bubble) {
        u.bubble.tick(dtMs);
        if (u.bubble.done) {
          u.bubble.destroy();
          u.bubble = null;
        }
      }
    }
    if (this.focusPerp) {
      const u = this.units.get(this.focusPerp);
      if (u) u.ring.scale.set(1 + Math.sin(this.pulse * 6) * 0.12);
    }
  }

  update(world: WireWorld, w: number, h: number): void {
    this.w = w;
    this.h = h;
    const cols = world.config.gridWidth;
    const rows = world.config.gridHeight;
    const cellX = w / cols;
    const cellY = h / rows;
    this.cell = Math.min(cellX, cellY);
    const cell = this.cell;
    const tod = timeOfDayForSegment(world.calendar.segment, world.config.segmentsPerDay);
    const focusing = this.focusPerp !== null;

    this.bg.clear();
    this.bg.rect(0, 0, w, h).fill(TOD_BG[tod]);
    this.grid.clear();
    for (let c = 1; c < cols; c++) this.grid.moveTo(c * cellX, 0).lineTo(c * cellX, h);
    for (let r = 1; r < rows; r++) this.grid.moveTo(0, r * cellY).lineTo(w, r * cellY);
    this.grid.stroke({ width: 1, color: 0xffffff, alpha: 0.05 });
    this.vignette.clear();
    if (focusing) this.vignette.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.45 });

    this.renderItems(world, cellX, cellY);

    const victims = focusing ? [...this.focusSet].filter((id) => id !== this.focusPerp) : [];

    const seen = new Set<string>();
    for (const v of world.villagers) {
      if (!v.alive) continue;
      seen.add(v.id);
      let u = this.units.get(v.id);
      if (!u) {
        u = this.createUnit(v.name, this.tex.get(animalFor(v))!, (v.position.x + 0.5) * cellX, (v.position.y + 0.5) * cellY);
        this.units.set(v.id, u);
        this.layer.addChild(u.node);
      }
      u.awake = isAwake(v.activity, world.calendar.segment, world.config.segmentsPerDay);

      // 役割と目標。
      const isPerp = this.focusPerp === v.id;
      const isVictim = this.focusSet.has(v.id) && !isPerp;
      const inFocus = isPerp || isVictim;
      if (!focusing) {
        u.role = 'idle';
      } else if (isPerp) {
        u.role = 'perp';
        u.tx = this.sceneCx;
        u.ty = this.sceneCy;
      } else if (isVictim) {
        u.role = 'victim';
        const i = victims.indexOf(v.id);
        const ang = (Math.PI * 2 * i) / Math.max(1, victims.length);
        u.tx = this.sceneCx + Math.cos(ang) * cell * 1.6;
        u.ty = this.sceneCy + Math.sin(ang) * cell * 1.6;
      } else {
        if (u.scatter === null) u.scatter = Math.random() < 0.5 ? 'flee' : 'gather';
        u.role = u.scatter;
        const ang = hash(v.id) % 360 * (Math.PI / 180);
        if (u.scatter === 'gather') {
          u.tx = this.sceneCx + Math.cos(ang) * cell * 3.2;
          u.ty = this.sceneCy + Math.sin(ang) * cell * 3.2;
        } else {
          // 逃げる: 現場から最寄りの縁へ。
          const dirX = u.px - this.sceneCx;
          const dirY = u.py - this.sceneCy;
          const n = Math.hypot(dirX, dirY) || 1;
          u.tx = Math.max(cell, Math.min(w - cell, u.px + (dirX / n) * cell * 4));
          u.ty = Math.max(cell, Math.min(h - cell, u.py + (dirY / n) * cell * 4));
        }
      }

      const big = inFocus ? 1.35 : 1;
      const size = cell * 0.95 * big;
      u.sprite.width = size;
      u.sprite.height = size;
      u.label.text = villagerDisplayName(world, v);
      const ringColor = isPerp
        ? 0xeb5757
        : isVictim
          ? 0x56ccf2
          : v.madman
            ? 0x9b51e0
            : AXIS_COLOR[dominantAxis(v.persona.traits)];
      u.ring.clear();
      u.ring.circle(0, 0, cell * 0.6 * big).stroke({ width: isPerp ? 4 : 3, color: ringColor, alpha: 0.95 });
      u.ring.scale.set(1);
      u.label.y = -cell * 0.7 * big;
      u.zzz.y = -cell * 0.95 * big;
      u.node.zIndex = inFocus ? 10 : 0;
      u.node.alpha = focusing && !inFocus ? 0.32 : u.awake ? 1 : 0.45;
      u.zzz.visible = !u.awake;
    }
    for (const [id, u] of this.units) {
      if (!seen.has(id)) {
        u.node.destroy({ children: true });
        this.units.delete(id);
      }
    }
  }

  /** フィールドアイテム (§16) を絵文字でマス目に描く。world.items と表示ノードを突き合わせる。 */
  private renderItems(world: WireWorld, cellX: number, cellY: number): void {
    const seen = new Set<string>();
    for (const item of world.items) {
      seen.add(item.id);
      let node = this.itemNodes.get(item.id);
      if (!node) {
        node = new Text({ text: item.kind === 'precious' ? '💎' : '💊', style: { fontSize: 16 } });
        node.anchor.set(0.5);
        this.itemLayer.addChild(node);
        this.itemNodes.set(item.id, node);
      }
      node.x = (item.position.x + 0.5) * cellX;
      node.y = (item.position.y + 0.5) * cellY;
    }
    for (const [id, node] of this.itemNodes) {
      if (!seen.has(id)) {
        node.destroy();
        this.itemNodes.delete(id);
      }
    }
  }

  private createUnit(name: string, tex: Texture, x: number, y: number): Unit {
    const node = new Container();
    node.x = x;
    node.y = y;
    const ring = new Graphics();
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    const label = new Text({ text: name, style: { fontSize: 13, fill: 0xffffff, fontWeight: 'bold' } });
    label.anchor.set(0.5);
    const zzz = new Text({ text: '💤', style: { fontSize: 14 } });
    zzz.anchor.set(0.5);
    zzz.visible = false;
    node.addChild(ring, sprite, label, zzz);
    return {
      node, ring, sprite, label, zzz, bubble: null,
      px: x, py: y, tx: x, ty: y, wanderMs: Math.random() * 1500, awake: true, role: 'idle', scatter: null,
    };
  }
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
