// 雑談ディレクタ。事件が起きていない暇な間、awake などうぶつへ
// ランダムで吹き出しを出して画面をにぎやかにする (装飾。裁判には無関係)。

import type { WireWorld } from '@pagus/sim';
import type { VillageScene } from './village-scene.js';

const CALM_LINES = [
  'いい天気だね',
  'おなかすいたなあ',
  'きょうもひま〜',
  'どんぐり拾った',
  'ねむい…',
  'さんぽ行こ',
  'なんかいい匂い',
  'のんびりするか',
  'お、誰かいる',
  'ふぁ〜あ',
  'まったりだね',
  'おやつまだ？',
];

const ANGRY_LINES = [
  'は？',
  'うるさいなあ',
  'どいてよ',
  'ちっ',
  'なんだよ',
  'こっち見るな',
];

export class ChatterDirector {
  private world: WireWorld | null = null;
  private timer = 1500;

  constructor(private readonly scene: VillageScene) {}

  setWorld(world: WireWorld): void {
    this.world = world;
  }

  /** active=true のときだけ喋らせる (村シーン表示中 & 事件なし)。 */
  tick(dtMs: number, active: boolean): void {
    if (!active || !this.world) return;
    this.timer -= dtMs;
    if (this.timer > 0) return;
    this.timer = 1400 + Math.random() * 2200;

    const ids = this.scene.awakeIds(this.world);
    if (ids.length === 0) return;
    const id = ids[Math.floor(Math.random() * ids.length)];
    if (id === undefined) return;

    const angry = Math.random() < 0.18;
    const pool = angry ? ANGRY_LINES : CALM_LINES;
    const line = pool[Math.floor(Math.random() * pool.length)] ?? '…';
    this.scene.say(id, line, angry ? 'angry' : 'calm');
  }
}
