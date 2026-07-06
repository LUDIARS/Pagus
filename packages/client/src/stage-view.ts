// PixiJS ステージ。フェーズで村/裁判シーンを切り替え、毎フレーム自走させる。
// - 転/結 → 裁判シーン。それ以外 → 村シーン。
// - 事件中は当事者へフォーカス + GANs ステップを吹き出しで描写。
// - 暇な間は雑談ディレクタがにぎやかにする。

import { Application } from 'pixi.js';
import type { WireWorld, Phase, TrialLine, TrialVoice, ThemeLexicon } from '@pagus/sim';
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
  private villagerTapHandler: ((villagerId: string) => void) | null = null;

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
    this.village = new VillageScene(tex, (villagerId) => this.villagerTapHandler?.(villagerId));
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

  setVillagerTapHandler(handler: ((villagerId: string) => void) | null): void {
    this.villagerTapHandler = handler;
  }

  /** プレイヤーの有罪/無罪表明を裁判シーンの吹き出しに出す。 */
  playerVerdict(side: 'guilty' | 'innocent'): void {
    if (this.inTrial) this.trial.playerSay(side);
  }

  /** server 生成の糾弾セリフを裁判シーンへ渡す。 */
  setTrialLines(incidentId: string, lines: TrialLine[]): void {
    this.trial.setLines(incidentId, lines);
  }

  /** 他ユーザーの裁判の声を裁判シーンへ渡す。 */
  setTrialVoices(incidentId: string, voices: TrialVoice[]): void {
    this.trial.setVoices(incidentId, voices);
  }

  /** テーマパック (§v1.4-D) の語彙を裁判シーンへ適用する。 */
  setTheme(lex: ThemeLexicon): void {
    this.trial.setTheme({
      trialOpen: lex.trialOpen,
      stageFoolish: lex.stageFoolish,
      stageFate: lex.stageFate,
      stageDecided: lex.stageDecided,
      taunts: lex.taunts,
      defenses: lex.defenses,
      denounces: lex.denounces,
      retorts: lex.retorts,
      screams: lex.screams,
      reliefs: lex.reliefs,
    });
  }

  /**
   * プレイヤーの行動 (§4/§v1.4-A) に対象どうぶつが即リアクションする吹き出し
   * (介入 2 点セットの「3 秒で見える」側)。村シーン表示中のみ。裁判中は何もしない。
   */
  reactToAction(targetId: string, type: 'incite' | 'sanction' | 'cheer' | 'champion' | 'gift-treat' | 'gift-poison' | 'fanFlames'): void {
    if (this.inTrial) return;
    const react: Record<typeof type, { text: string; tone: 'calm' | 'angry' }> = {
      incite: { text: 'なんだと…！？', tone: 'angry' },
      sanction: { text: 'やめてくれ…！', tone: 'angry' },
      cheer: { text: 'ありがとう！うれしい！', tone: 'calm' },
      champion: { text: '推されてる…！', tone: 'calm' },
      'gift-treat': { text: 'わぁ、ありがとう！🍬', tone: 'calm' },
      'gift-poison': { text: 'うっ…なんだこれ…', tone: 'angry' },
      fanFlames: { text: '噂が広まっていく…', tone: 'angry' },
    };
    const r = react[type];
    this.village.say(targetId, r.text, r.tone);
  }

  /** 野次 (§v1.4-A) のリアクション: 事件の加害者が観客の声にざわつく吹き出し。 */
  reactToHeckle(side: 'agitate' | 'soothe'): void {
    if (this.inTrial) return;
    const perpetrator = this.last?.incident?.perpetrator;
    if (!perpetrator) return;
    if (side === 'agitate') this.village.say(perpetrator, '観客が騒いでいる…！', 'angry');
    else this.village.say(perpetrator, '観客がなだめている…', 'calm');
  }

  /** 証言 (§v1.4-A) の吹き出し: 裁判シーンにプレイヤーの証言を出す。 */
  playerTestify(stance: 'accuse' | 'defend', text?: string): void {
    if (this.inTrial) this.trial.testifySay(stance, text);
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
