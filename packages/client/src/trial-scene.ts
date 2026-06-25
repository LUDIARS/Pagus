// 裁判シーン: 全どうぶつが演習場に整列。
// - 糾弾は一人ずつ順番に (とげとげの大きい吹き出し)。被告は被害者や他をやり返す。
// - 判決が出たら敗者 (処刑される被告) の悲鳴・断末魔を演出する。
// キャラは永続ノード、配置は update()、セリフ送り/シェイク/断末魔は tick()。

import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { WireWorld, Villager } from '@pagus/sim';
import { animalFor, type AnimalName } from './assets.js';
import { AnimatedBubble } from './animated-bubble.js';

const DENOUNCE = [
  '{d}は最も愚かだ！',
  '恥を知れ、{d}！',
  '許せない！',
  '{d}を追放しろ！',
  'よくもやったな！',
  '弁明は無用だ！',
  '罪を数えろ！',
  'これが村の総意だ！',
];
const RETORT = ['{t}こそ悪い！', 'お前らだって！', '濡れ衣だ！', 'ふざけるな！', '{t}が先に手を出した！', '知るか！'];
const SCREAM = ['ぎゃあああ！', 'ぐ…ぅ…', 'うわあああ…', 'た…たすけ…', '…ぁ'];
const RELIEF = ['た、助かった…', 'もう二度としない', 'ひっく…ぐすっ', 'こわかった…'];

interface Utterance {
  speaker: string;
  text: string;
}
interface TChar {
  node: Container;
  sprite: Sprite;
  label: Text;
  tag: Text;
  bubble: AnimatedBubble | null;
  baseX: number;
  baseY: number;
  size: number;
}

export class TrialScene {
  readonly root = new Container();
  private readonly bg = new Graphics();
  private readonly fx = new Graphics();
  private readonly layer = new Container();
  private readonly title = new Text({ text: '', style: { fontSize: 22, fill: 0xf2c94c, fontWeight: 'bold' } });
  private readonly chars = new Map<string, TChar>();

  private script: Utterance[] = [];
  private scriptKey = '';
  private idx = -1;
  private timer = 0;
  private active: string | null = null;
  private defendantId: string | null = null;
  private finale: 'death' | 'spared' | null = null;
  private defFade = 0;

  constructor(private readonly tex: Map<AnimalName, Texture>) {
    this.title.anchor.set(0.5, 0);
    this.layer.sortableChildren = true;
    this.root.addChild(this.bg, this.layer, this.fx, this.title);
  }

  update(world: WireWorld, w: number, h: number): void {
    const trial = world.trial;
    this.bg.clear();
    this.bg.rect(0, 0, w, h).fill(0x161019);
    this.bg.ellipse(w / 2, h * 0.34, w * 0.36, h * 0.17).fill(0x241a2b);
    this.bg.ellipse(w / 2, h * 0.34, w * 0.36, h * 0.17).stroke({ width: 2, color: 0x5a3a2a, alpha: 0.7 });

    if (!trial) {
      this.clearChars(new Set());
      return;
    }
    const byId = new Map(world.villagers.map((v) => [v.id, v]));
    const targetId = trial.defendant ?? world.incident?.perpetrator ?? trial.candidates[0] ?? null;
    this.defendantId = targetId;
    const target = targetId ? byId.get(targetId) ?? null : null;
    const accusers = world.villagers.filter((v) => v.alive && v.id !== targetId);
    const victims = world.incident?.involved ?? [];

    const stageLabel =
      trial.stage === 'foolish' ? '最も愚かな行動を裁く' : trial.stage === 'fate' ? '殺すか、活かすか' : '判決';
    this.title.text = `⚖ 裁判 — ${stageLabel}`;
    this.title.x = w / 2;
    this.title.y = 12;

    const base = Math.min(w, h);
    const keep = new Set<string>();

    // 被告: 中央壇上。
    if (target) {
      keep.add(target.id);
      this.placeChar(target, w / 2, h * 0.34, base * 0.2, true);
    }
    // 非難する側: 下段に整列。
    const n = Math.max(1, accusers.length);
    const margin = w * 0.08;
    const span = w - margin * 2;
    accusers.forEach((v, i) => {
      keep.add(v.id);
      this.placeChar(v, margin + (span * (i + 0.5)) / n, h * 0.74, base * 0.12, false);
    });
    this.clearChars(keep);

    // セリフ台本 (事件 or 判決が変わったら組み直す)。
    const key = `${trial.incidentId}:${trial.verdict ?? trial.stage}`;
    if (key !== this.scriptKey) {
      this.scriptKey = key;
      this.buildScript(trial.verdict, target, accusers, victims, byId);
    }
  }

  tick(dtMs: number): void {
    // セリフ送り。
    this.timer -= dtMs;
    if (this.script.length > 0 && this.timer <= 0) {
      this.timer = this.finale ? 1300 : 1900;
      const last = this.idx >= this.script.length - 1;
      if (this.finale && last) {
        // 断末魔は最後で止める (ループしない)。
      } else {
        this.idx = (this.idx + 1) % this.script.length;
        this.speak();
      }
    }

    for (const [id, c] of this.chars) {
      if (c.bubble) {
        c.bubble.tick(dtMs);
        if (c.bubble.done) {
          c.bubble.destroy();
          c.bubble = null;
        }
      }
      // 喋っている者を小刻みに、断末魔の被告は激しく揺らす。
      const speaking = id === this.active;
      const dying = this.finale === 'death' && id === this.defendantId;
      const amp = dying ? 6 : speaking ? 2 : 0;
      c.node.x = c.baseX + (amp ? (Math.random() - 0.5) * amp : 0);
      c.node.y = c.baseY + (dying ? this.defFade * c.size * 0.5 : 0) + (amp ? (Math.random() - 0.5) * amp : 0);
    }

    if (this.finale === 'death' && this.defendantId) {
      this.defFade = Math.min(1, this.defFade + dtMs / 4000);
      const c = this.chars.get(this.defendantId);
      if (c) {
        c.sprite.tint = 0xff5555;
        c.sprite.alpha = 1 - this.defFade * 0.7;
      }
    }
  }

  private speak(): void {
    const u = this.script[this.idx];
    if (!u) return;
    const c = this.chars.get(u.speaker);
    if (!c) return;
    if (c.bubble) c.bubble.destroy();
    const b = new AnimatedBubble(u.text, 'angry', this.finale ? 1100 : 1500);
    b.node.y = -c.size * 0.7;
    c.node.addChild(b.node);
    c.bubble = b;
    this.active = u.speaker;
  }

  private buildScript(
    verdict: string | null,
    target: Villager | null,
    accusers: Villager[],
    victims: string[],
    byId: Map<string, Villager>,
  ): void {
    this.idx = -1;
    this.timer = 0;
    this.active = null;
    const dname = target?.name ?? '被告';

    if (verdict && target) {
      // 判決後: 敗者の悲鳴 (処刑) or 安堵 (教育)。
      this.finale = verdict === 'death' ? 'death' : 'spared';
      this.defFade = 0;
      const lines = verdict === 'death' ? SCREAM : RELIEF;
      this.script = lines.map((t) => ({ speaker: target.id, text: t }));
      return;
    }

    // 審理中: 一人ずつ糾弾 + 被告のやり返し。
    this.finale = null;
    const out: Utterance[] = [];
    accusers.forEach((v, i) => {
      out.push({ speaker: v.id, text: pick(DENOUNCE, v.id).replace('{d}', dname) });
      if (target && i % 2 === 1) {
        const tname = victims.length ? byId.get(victims[i % victims.length] ?? '')?.name ?? '被害者' : accusers[0]?.name ?? '誰か';
        out.push({ speaker: target.id, text: pick(RETORT, `${target.id}${i}`).replace('{t}', tname) });
      }
    });
    this.script = out.length ? out : [{ speaker: target?.id ?? accusers[0]?.id ?? '', text: '…' }];
  }

  private placeChar(v: Villager, x: number, y: number, size: number, defendant: boolean): void {
    let c = this.chars.get(v.id);
    if (!c) {
      const node = new Container();
      const sprite = new Sprite(this.tex.get(animalFor(v))!);
      sprite.anchor.set(0.5);
      const label = new Text({ text: v.name, style: { fontSize: 12, fill: 0xffffff, fontWeight: 'bold' } });
      label.anchor.set(0.5);
      const tag = new Text({ text: '被告', style: { fontSize: 13, fill: 0xeb5757, fontWeight: 'bold' } });
      tag.anchor.set(0.5);
      tag.visible = false;
      node.addChild(sprite, label, tag);
      this.layer.addChild(node);
      c = { node, sprite, label, tag, bubble: null, baseX: x, baseY: y, size };
      this.chars.set(v.id, c);
    }
    c.sprite.texture = this.tex.get(animalFor(v))!;
    c.sprite.width = size;
    c.sprite.height = size;
    c.sprite.tint = 0xffffff;
    c.sprite.alpha = 1;
    c.label.y = size * 0.62;
    c.baseX = x;
    c.baseY = y;
    c.size = size;
    c.node.zIndex = defendant ? 5 : 1;
    c.tag.y = -size * 0.78;
    c.tag.visible = defendant;
  }

  private clearChars(keep: Set<string>): void {
    for (const [id, c] of this.chars) {
      if (!keep.has(id)) {
        c.node.destroy({ children: true });
        this.chars.delete(id);
      }
    }
  }
}

function pick(pool: string[], seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return pool[(h >>> 0) % pool.length] ?? pool[0] ?? '…';
}
