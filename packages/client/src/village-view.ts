// PixiJS の 2D トップダウン村ビュー。どうぶつの移動・睡眠・時間帯の色調を描く。

import { Application, Container, Graphics, Text } from 'pixi.js';
import { dominantAxis, isAwake, timeOfDayForSegment } from '@pagus/sim';
import type { WireWorld, PersonalityAxis, TimeOfDay } from '@pagus/sim';

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

interface Sprite {
  node: Container;
  dot: Graphics;
  label: Text;
  zzz: Text;
}

export class VillageView {
  private readonly app = new Application();
  private readonly bg = new Graphics();
  private readonly layer = new Container();
  private readonly sprites = new Map<string, Sprite>();
  private readonly size = 576;

  async mount(el: HTMLElement): Promise<void> {
    await this.app.init({ width: this.size, height: this.size, antialias: true, background: 0x0b0e14 });
    el.appendChild(this.app.canvas);
    this.app.stage.addChild(this.bg);
    this.app.stage.addChild(this.layer);
  }

  update(world: WireWorld): void {
    const cells = Math.max(world.config.gridWidth, world.config.gridHeight);
    const cell = this.size / cells;
    const tod = timeOfDayForSegment(world.calendar.segment, world.config.segmentsPerDay);
    this.bg.clear();
    this.bg.rect(0, 0, this.size, this.size).fill(TOD_BG[tod]);

    const seen = new Set<string>();
    for (const v of world.villagers) {
      if (!v.alive) continue;
      seen.add(v.id);
      let s = this.sprites.get(v.id);
      if (!s) {
        s = this.createSprite(v.name);
        this.sprites.set(v.id, s);
        this.layer.addChild(s.node);
      }
      const awake = isAwake(v.activity, world.calendar.segment, world.config.segmentsPerDay);
      s.dot.clear();
      s.dot.circle(0, 0, cell * 0.4).fill(AXIS_COLOR[dominantAxis(v.persona.traits)]);
      s.node.x = (v.position.x + 0.5) * cell;
      s.node.y = (v.position.y + 0.5) * cell;
      s.node.alpha = awake ? 1 : 0.4;
      s.zzz.visible = !awake;
    }
    for (const [id, s] of this.sprites) {
      if (!seen.has(id)) {
        s.node.destroy({ children: true });
        this.sprites.delete(id);
      }
    }
  }

  private createSprite(name: string): Sprite {
    const node = new Container();
    const dot = new Graphics();
    node.addChild(dot);
    const label = new Text({ text: name, style: { fontSize: 11, fill: 0xffffff } });
    label.anchor.set(0.5);
    label.y = -16;
    node.addChild(label);
    const zzz = new Text({ text: 'zzz', style: { fontSize: 10, fill: 0xcccccc } });
    zzz.anchor.set(0.5);
    zzz.y = -28;
    zzz.visible = false;
    node.addChild(zzz);
    return { node, dot, label, zzz };
  }
}
