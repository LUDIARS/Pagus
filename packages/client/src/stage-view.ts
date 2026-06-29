// PixiJS ステージ。フェーズで村/裁判シーンを切り替え、毎フレーム自走させる。
// - 転/結 → 裁判シーン。それ以外 → 村シーン。
// - 事件中は当事者へフォーカス + GANs ステップを吹き出しで描写。
// - 暇な間は雑談ディレクタがにぎやかにする。

import { Application } from 'pixi.js';
import type { WireWorld, Phase, TrialLine } from '@pagus/sim';
import { loadAnimalTextures } from './assets.js';
import { VillageScene } from './village-scene.js';
import { TrialScene } from './trial-scene.js';
import { ChatterDirector } from './chatter.js';

const TRIAL_PHASES: ReadonlySet<Phase> = new Set<Phase>(['ten', 'ketsu']);

export class StageView {
  private readonly app = new Application();
  private village!: VillageScene;
  private trial!: TrialScene;
  private chatter!: ChatterDirector;
  private width = 0;
  private height = 0;
  private last: WireWorld | null = null;
  private inTrial = false;
  private calm = true;
  private lastIncidentId: string | null = null;
  private lastStepCount = 0;

  async mount(el: HTMLElement): Promise<void> {
    this.width = Math.max(1, el.clientWidth);
    this.height = Math.max(1, el.clientHeight);
    await this.app.init({
      width: this.width,
      height: this.height,
      antialias: true,
      background: 0x0b0e14,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    el.appendChild(this.app.canvas);

    const tex = await loadAnimalTextures();
    this.village = new VillageScene(tex);
    this.trial = new TrialScene(tex);
    this.chatter = new ChatterDirector(this.village);
    this.app.stage.addChild(this.village.root, this.trial.root);

    const ro = new ResizeObserver(() => {
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      if (w === this.width && h === this.height) return;
      this.width = w;
      this.height = h;
      this.app.renderer.resize(w, h);
      if (this.last) this.update(this.last);
    });
    ro.observe(el);

    this.app.ticker.add(() => this.onTick(this.app.ticker.deltaMS));
  }

  /** 裁判中か (有罪/無罪ボタンの表示制御に使う)。 */
  get isTrial(): boolean {
    return this.inTrial;
  }

  /** プレイヤーの有罪/無罪表明を裁判シーンの吹き出しに出す。 */
  playerVerdict(side: 'guilty' | 'innocent'): void {
    if (this.inTrial) this.trial.playerSay(side);
  }

  /** server 生成の糾弾セリフを裁判シーンへ渡す。 */
  setTrialLines(incidentId: string, lines: TrialLine[]): void {
    this.trial.setLines(incidentId, lines);
  }

  /**
   * プレイヤーの行動 (§4) に対象どうぶつが即リアクションする吹き出し (扇動の手応えが無い問題への対応)。
   * 村シーン表示中のみ。裁判中は何もしない。
   */
  reactToAction(targetId: string, type: 'incite' | 'sanction' | 'cheer' | 'champion'): void {
    if (this.inTrial) return;
    const react: Record<typeof type, { text: string; tone: 'calm' | 'angry' }> = {
      incite: { text: 'なんだと…！？', tone: 'angry' },
      sanction: { text: 'やめてくれ…！', tone: 'angry' },
      cheer: { text: 'ありがとう！', tone: 'calm' },
      champion: { text: '推されてる…！', tone: 'calm' },
    };
    const r = react[type];
    this.village.say(targetId, r.text, r.tone);
  }

  update(world: WireWorld): void {
    this.last = world;
    this.chatter.setWorld(world);
    this.inTrial = TRIAL_PHASES.has(world.phase);
    const hasIncident = world.incident !== null;
    this.calm = !this.inTrial && !hasIncident;

    this.village.root.visible = !this.inTrial;
    this.trial.root.visible = this.inTrial;

    // 事件フォーカス (裁判前の承フェーズ)。
    if (!this.inTrial && world.incident) {
      this.village.setFocus(world.incident.perpetrator, world.incident.involved);
    } else if (!this.inTrial) {
      this.village.setFocus(null, null);
    }

    // 事件の様子 (GANs ステップ) を吹き出しで描写。
    this.depictIncident(world);

    if (this.inTrial) this.trial.update(world, this.width, this.height);
    else this.village.update(world, this.width, this.height);
  }

  private depictIncident(world: WireWorld): void {
    const inc = world.incident;
    if (!inc) {
      this.lastIncidentId = null;
      this.lastStepCount = 0;
      return;
    }
    if (inc.id !== this.lastIncidentId) {
      this.lastIncidentId = inc.id;
      this.lastStepCount = 0;
    }
    if (this.inTrial) return;
    for (let i = this.lastStepCount; i < inc.steps.length; i++) {
      const s = inc.steps[i];
      if (!s) continue;
      const who = s.perspective === 'perpetrator' ? inc.perpetrator : inc.involved[0] ?? inc.perpetrator;
      this.village.say(who, s.action.length > 24 ? `${s.action.slice(0, 24)}…` : s.action, 'angry');
    }
    this.lastStepCount = inc.steps.length;
  }

  private onTick(dtMs: number): void {
    if (this.inTrial) {
      this.trial.tick(dtMs);
    } else {
      this.village.tick(dtMs);
      this.chatter.tick(dtMs, this.calm);
    }
  }
}
