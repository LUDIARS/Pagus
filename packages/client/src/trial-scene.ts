// 裁判シーン: 全どうぶつが演習場に整列。
// - 糾弾は一人ずつ順番に (とげとげの大きい吹き出し)。被告は被害者や他をやり返す。
// - 判決が出たら敗者 (処刑される被告) の悲鳴・断末魔を演出する。
// キャラは永続ノード、配置は update()、セリフ送り/シェイク/断末魔は tick()。

import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import { pickTrialAttendees, type WireWorld, type Villager, type TrialLine, type TrialVoice } from '@pagus/sim';
import { animalFor, type AnimalName } from './assets.js';
import { AnimatedBubble, type BubbleColors } from './animated-bubble.js';
import { villagerDisplayName } from './villager-display.js';

/** プレイヤーの吹き出し色 (村人と区別)。有罪=紫系 / 無罪=青系。 */
const PLAYER_COLORS: Record<'guilty' | 'innocent', BubbleColors> = {
  guilty: { bg: 0xf3c4ff, fill: 0x5e0a82, stroke: 0x9b1fb0 },
  innocent: { bg: 0xbfe9ff, fill: 0x0a4a6e, stroke: 0x1f7fb0 },
};
const TAUNTS = ['有罪だ！', '吊るしてしまえ！', '言い逃れするな！', 'お前がやった！', '万死に値する！'];
const DEFENSES = ['無罪だ！', 'その子は悪くない！', '証拠がない！', 'やめてやれ！', '冤罪だ！'];

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

/** テーマパック (§v1.4-D) で差し替え可能な語彙。既定は classic 相当の組込み定数。 */
interface TrialLexicon {
  trialOpen: string;
  stageFoolish: string;
  stageFate: string;
  stageDecided: string;
  taunts: string[];
  defenses: string[];
  denounces: string[];
  retorts: string[];
  screams: string[];
  reliefs: string[];
}

export class TrialScene {
  readonly root = new Container();
  private readonly bg = new Graphics();
  private readonly layer = new Container();
  private readonly voiceLayer = new Container();
  private readonly title = new Text({ text: '', style: { fontSize: 22, fill: 0xf2c94c, fontWeight: 'bold' } });
  private readonly chars = new Map<string, TChar>();
  private lex: TrialLexicon = {
    trialOpen: '審判の時',
    stageFoolish: '最も愚かな行動を裁く',
    stageFate: '殺すか、活かすか',
    stageDecided: '判決',
    taunts: TAUNTS,
    defenses: DEFENSES,
    denounces: DENOUNCE,
    retorts: RETORT,
    screams: SCREAM,
    reliefs: RELIEF,
  };

  /** テーマパック (§v1.4-D) の語彙を適用する。次の台本組み直しから効く。 */
  setTheme(lex: TrialLexicon): void {
    this.lex = lex;
    this.scriptKey = ''; // 台本を組み直させる。
  }

  private script: Utterance[] = [];
  private scriptKey = '';
  private idx = -1;
  private timer = 0;
  private active: string | null = null;
  private defendantId: string | null = null;
  private finale: 'death' | 'spared' | null = null;
  private defFade = 0;
  private w = 1;
  private h = 1;
  private playerBubble: AnimatedBubble | null = null;
  private incidentId: string | null = null;
  /** server から来た糾弾セリフ (speaker id → text)。無ければ定型文。 */
  private serverLines: { incidentId: string; byId: Map<string, string> } | null = null;
  private sharedVoices: { incidentId: string; voices: TrialVoice[] } | null = null;
  private voiceKey = '';

  constructor(private readonly tex: Map<AnimalName, Texture>) {
    this.title.anchor.set(0.5, 0);
    this.layer.sortableChildren = true;
    this.root.addChild(this.bg, this.layer, this.voiceLayer, this.title);
  }

  /** server 生成の糾弾セリフを受け取る (次の update で台本へ反映)。 */
  setLines(incidentId: string, lines: TrialLine[]): void {
    const byId = new Map(lines.map((l) => [l.speaker, l.text]));
    this.serverLines = { incidentId, byId };
    this.scriptKey = ''; // 台本を組み直させる。
  }

  /** 他ユーザーの裁判の声と、信仰している住民の応答を受け取る。 */
  setVoices(incidentId: string, voices: TrialVoice[]): void {
    this.sharedVoices = { incidentId, voices };
    this.voiceKey = '';
  }

  /** プレイヤーの罵倒(有罪)/擁護(無罪)を画面下部中央に表示する。 */
  playerSay(side: 'guilty' | 'innocent'): void {
    const pool = side === 'guilty' ? this.lex.taunts : this.lex.defenses;
    const text = pool[Math.floor(Math.random() * pool.length)] ?? '…';
    this.showPlayerBubble(`あなた「${text}」`, side);
  }

  /** プレイヤーの証言 (§v1.4-A) を画面下部中央に表示する。text 無しは定型文。 */
  testifySay(stance: 'accuse' | 'defend', text?: string): void {
    const fallback = stance === 'accuse' ? 'わたしは見た。あいつがやったんだ！' : 'あの子はそんなことをする子じゃない！';
    this.showPlayerBubble(`証言「${text ?? fallback}」`, stance === 'accuse' ? 'guilty' : 'innocent');
  }

  private showPlayerBubble(line: string, side: 'guilty' | 'innocent'): void {
    if (this.playerBubble) this.playerBubble.destroy();
    const b = new AnimatedBubble(line, 'angry', 1700, PLAYER_COLORS[side]);
    b.node.x = this.w / 2;
    b.node.y = this.h * 0.96;
    this.root.addChild(b.node);
    this.playerBubble = b;
  }

  update(world: WireWorld, w: number, h: number): void {
    this.w = w;
    this.h = h;
    const trial = world.trial;
    this.bg.clear();
    this.bg.rect(0, 0, w, h).fill(0x161019);
    this.bg.ellipse(w / 2, h * 0.34, w * 0.36, h * 0.17).fill(0x241a2b);
    this.bg.ellipse(w / 2, h * 0.34, w * 0.36, h * 0.17).stroke({ width: 2, color: 0x5a3a2a, alpha: 0.7 });

    if (!trial) {
      this.clearChars(new Set());
      this.clearVoices();
      return;
    }
    this.incidentId = trial.incidentId;
    const byId = new Map(world.villagers.map((v) => [v.id, v]));
    const targetId = trial.defendant ?? world.incident?.perpetrator ?? trial.candidates[0] ?? null;
    this.defendantId = targetId;
    const target = targetId ? byId.get(targetId) ?? null : null;
    const accusers = pickTrialAttendees(world.villagers, targetId, trial.incidentId);
    const victims = world.incident?.involved ?? [];

    const stageLabel =
      trial.stage === 'foolish' ? this.lex.stageFoolish : trial.stage === 'fate' ? this.lex.stageFate : this.lex.stageDecided;
    this.title.text = `—— ${this.lex.trialOpen} ——　${stageLabel}`;
    this.title.x = w / 2;
    this.title.y = 12;

    const base = Math.min(w, h);
    const keep = new Set<string>();

    // 被告: 中央壇上。
    if (target) {
      keep.add(target.id);
      this.placeChar(world, target, w / 2, h * 0.34, base * 0.2, true);
    }
    // 非難する側: 下段に整列。
    const n = Math.max(1, accusers.length);
    const margin = w * 0.08;
    const span = w - margin * 2;
    accusers.forEach((v, i) => {
      keep.add(v.id);
      this.placeChar(world, v, margin + (span * (i + 0.5)) / n, h * 0.74, base * 0.12, false);
    });
    this.clearChars(keep);

    // セリフ台本 (事件 or 判決が変わったら組み直す)。
    const key = `${trial.incidentId}:${trial.verdict ?? trial.stage}`;
    if (key !== this.scriptKey) {
      this.scriptKey = key;
      this.buildScript(world, trial.verdict, target, accusers, victims, byId);
    }
    this.renderVoices(target, accusers);
  }

  tick(dtMs: number): void {
    // プレイヤーの吹き出し。
    if (this.playerBubble) {
      this.playerBubble.node.x = this.w / 2;
      this.playerBubble.node.y = this.h * 0.96;
      this.playerBubble.tick(dtMs);
      if (this.playerBubble.done) {
        this.playerBubble.destroy();
        this.playerBubble = null;
      }
    }

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
    world: WireWorld,
    verdict: string | null,
    target: Villager | null,
    accusers: Villager[],
    victims: string[],
    byId: Map<string, Villager>,
  ): void {
    this.idx = -1;
    this.timer = 0;
    this.active = null;
    const dname = target ? villagerDisplayName(world, target) : '被告';

    if (verdict && target) {
      // 判決後: 敗者の悲鳴 (処刑) or 安堵 (教育)。
      this.finale = verdict === 'death' ? 'death' : 'spared';
      this.defFade = 0;
      const lines = verdict === 'death' ? this.lex.screams : this.lex.reliefs;
      this.script = lines.map((t) => ({ speaker: target.id, text: t }));
      return;
    }

    // 審理中: 一人ずつ糾弾 + 被告のやり返し。
    this.finale = null;
    const out: Utterance[] = [];
    const sLines = this.serverLines && this.serverLines.incidentId === this.incidentId ? this.serverLines.byId : null;
    accusers.forEach((v, i) => {
      // server 生成 (Haiku) の糾弾があれば優先、無ければ定型文。
      const text = sLines?.get(v.id) ?? pick(this.lex.denounces, v.id).replace('{d}', dname);
      out.push({ speaker: v.id, text });
      if (target && i % 2 === 1) {
        const victim = victims.length ? byId.get(victims[i % victims.length] ?? '') : null;
        const tname = victim ? villagerDisplayName(world, victim) : accusers[0] ? villagerDisplayName(world, accusers[0]) : '誰か';
        out.push({ speaker: target.id, text: pick(this.lex.retorts, `${target.id}${i}`).replace('{t}', tname) });
      }
    });
    this.script = out.length ? out : [{ speaker: target?.id ?? accusers[0]?.id ?? '', text: '…' }];
  }

  private placeChar(world: WireWorld, v: Villager, x: number, y: number, size: number, defendant: boolean): void {
    let c = this.chars.get(v.id);
    if (!c) {
      const node = new Container();
      const sprite = new Sprite(this.tex.get(animalFor(v))!);
      sprite.anchor.set(0.5);
      const label = new Text({ text: villagerDisplayName(world, v), style: { fontSize: 12, fill: 0xffffff, fontWeight: 'bold' } });
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
    c.label.text = villagerDisplayName(world, v);
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

  private renderVoices(target: Villager | null, accusers: Villager[]): void {
    if (!this.incidentId || this.sharedVoices?.incidentId !== this.incidentId) {
      this.clearVoices();
      return;
    }
    const voices = this.sharedVoices.voices.slice(-6);
    const key = `${this.incidentId}:${voices.map((v) => v.id).join(',')}:${Math.round(this.w)}:${Math.round(this.h)}`;
    if (key === this.voiceKey) return;
    this.voiceKey = key;
    this.clearVoices();
    voices.forEach((v, i) => {
      const anchorId = accusers[i % Math.max(1, accusers.length)]?.id ?? target?.id ?? '';
      const c = this.chars.get(anchorId);
      if (c) {
        const user = v.userName ?? v.userId.slice(0, 6);
        const verdict = v.pick === 'kill' ? '死刑' : '教育';
        const x = c.baseX + ((i % 3) - 1) * c.size * 0.55;
        const y = c.baseY - c.size * (1.05 + Math.floor(i / 3) * 0.28);
        this.voiceLayer.addChild(smallBubble(`${user}: ${verdict}`, x, y, v.pick === 'kill' ? 0x6b2a7d : 0x1f5d7a));
      }
      if (v.respondentId && v.responseText) {
        const r = this.chars.get(v.respondentId);
        if (!r) return;
        this.voiceLayer.addChild(smallBubble(v.responseText, r.baseX + r.size * 0.5, r.baseY - r.size * 1.2, 0xb77d1d));
      }
    });
  }

  private clearVoices(): void {
    this.voiceKey = '';
    this.voiceLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
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

function smallBubble(text: string, x: number, y: number, fill: number): Container {
  const node = new Container();
  const label = new Text({
    text: text.length > 18 ? `${text.slice(0, 18)}…` : text,
    style: { fontSize: 11, fill: 0xffffff, fontWeight: 'bold' },
  });
  label.anchor.set(0.5);
  const padX = 7;
  const padY = 4;
  const bg = new Graphics();
  const bw = Math.max(42, label.width + padX * 2);
  const bh = label.height + padY * 2;
  bg.roundRect(-bw / 2, -bh / 2, bw, bh, 6).fill({ color: fill, alpha: 0.88 }).stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
  node.addChild(bg, label);
  node.x = x;
  node.y = y;
  return node;
}
