import { isAwake, mixedPartsFor, PART_LABELS, type WireWorld, type TrialLine, type TrialVoice, type ThemeLexicon } from '@pagus/sim';
import { residentParts, triangulate, type Vec3 } from './resident-mesh.js';
import { VillageRenderer, type VillageMesh } from './village-renderer.js';
import { townScenery } from './town-scenery.js';
import { CourtTransition } from './court-transition.js';
import { MAX_VISIBLE_RESIDENTS, type TownArea } from '@pagus/sim';
import { townAreaCentre } from './town-area-centre.js';
import { townPoint } from './town-coordinates.js';
import { TownLabels } from './town-labels.js';
import { StoryPanel } from './story-panel.js';
import { villagerDisplayName } from './villager-display.js';
import './village-3d.css';
interface ResidentVisual {
    mesh: VillageMesh;
    signature: string;
    label: HTMLButtonElement;
    position: Vec3;
    target: Vec3;
    route: Vec3[];
    movementKey: string;
}
/** Presentation follows authoritative BT positions; it never invents simulation movement. */
export class StageView {
    private readonly courtTransition = new CourtTransition();
    private changingScene = false;
    private sceneGeneration = 0;
    /**
     * 遷移中は updateArea を止める。superseded / teardown では changeScene が呼ばれないため、
     * 自分が最新の遷移である場合に限りフラグを戻す (戻し損ねると法廷が固まったままになる)。
     */
    transitionScene(action: () => void): void {
        const generation = ++this.sceneGeneration;
        this.changingScene = true;
        const settle = (): void => { if (generation === this.sceneGeneration) this.changingScene = false; };
        void this.courtTransition.run(() => { action(); settle(); }).finally(settle);
    }
    private area: TownArea = 'plaza';
    /** Frames the subscribed district; the world is absent until the first snapshot. */
    resetCamera(): void {
        if (!this.renderer) return;
        this.renderer.focus = this.world ? townPoint(this.world.config, townAreaCentre(this.world.config, this.area)) : [0, 0, 0];
        this.renderer.zoom = 2.5;
        this.renderer.yaw = -.2;
    }
    setArea(area: TownArea): void {
        if (this.area === area) return;
        this.area = area;
        this.clearResidents();
        if (this.world) {
            this.update(this.world);
            this.resetCamera();
        }
    }
    addAreaControl(control: HTMLElement): void { this.controls.append(control); }
    /** Drop every resident visual so a new area starts from an empty stage. */
    clearResidents(): void {
        for (const visual of this.units.values()) {
            this.renderer?.release(visual.mesh);
            visual.label.remove();
        }
        this.units.clear();
        this.areaWorld = null;
    }
    private renderer: VillageRenderer | null = null;
    private host: HTMLElement | null = null;
    private readonly labels = document.createElement('div');
    private readonly controls = document.createElement('div');
    private readonly story = new StoryPanel();
    private readonly town = new TownLabels();
    private readonly speech = document.createElement('div');
    private readonly units = new Map<string, ResidentVisual>();
    private scenery: VillageMesh | null = null;
    private itemMesh: VillageMesh | null = null;
    private sceneryKey = '';
    private observer: ResizeObserver | null = null;
    private frame = 0;
    private lastTime = 0;
    private speechUntil = 0;
    private world: WireWorld | null = null;
    /** Last area frame: area-filtered, used only for resident meshes and routes. */
    private areaWorld: WireWorld | null = null;
    private tap: ((id: string) => void) | null = null;
    private trialKey = '';
    private voiceIds = new Set<string>();
    private lex: ThemeLexicon | null = null;
    private width = 1;
    private height = 1;
    private messages: string[] = [];
    private lastAmbientAction = '';
    async mount(el: HTMLElement): Promise<void> {
        if (this.host)
            throw new Error('StageView is already mounted');
        this.host = el;
        try {
            this.renderer = new VillageRenderer();
            this.resetCamera();
            this.town.onFocus = (position) => { if (this.renderer) { this.renderer.focus = position; this.renderer.zoom = Math.max(3.5, this.renderer.zoom); } };
            this.itemMesh = this.renderer.upload(triangulate([{ center: [0, .15, 0], radius: [.16, .2, .16], color: [.83, .66, .94] }]));
            this.labels.className = 'village-labels';
            this.controls.className = 'village-camera';
            this.speech.className = 'village-speech';
            this.speech.setAttribute('aria-live', 'polite');
            for (const [label, action] of [
                ['↶', () => {
                        if (this.renderer)
                            this.renderer.yaw -= .3;
                    }], ['↷', () => {
                        if (this.renderer)
                            this.renderer.yaw += .3;
                    }],
                ['＋', () => {
                        if (this.renderer)
                            this.renderer.zoom = Math.min(5, this.renderer.zoom + .25);
                    }],
                ['−', () => {
                        if (this.renderer)
                            this.renderer.zoom = Math.max(.7, this.renderer.zoom - .2);
                    }],
                ['⌂', () => this.resetCamera()],
            ] as const) {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = label;
                b.setAttribute('aria-label', label === '↶' ? '左へ回転' : label === '↷' ? '右へ回転' : label === '＋' ? '拡大' : label === '⌂' ? '現在のエリアにカメラを戻す' : '縮小');
                b.onclick = action;
                this.controls.append(b);
            }
            el.append(this.renderer.canvas, this.town.root, this.labels, this.controls, this.town.detail, this.story.root, this.speech, this.courtTransition.element);
            this.observer = new ResizeObserver(() => { this.width = el.clientWidth; this.height = el.clientHeight; });
            this.observer.observe(el);
            this.width = el.clientWidth;
            this.height = el.clientHeight;
            this.renderer.canvas.addEventListener('webglcontextlost', this.onContextLost);
            window.addEventListener('pagehide', this.onPageHide);
            this.frame = requestAnimationFrame(this.tick);
        }
        catch (error) {
            this.destroy();
            const message = document.createElement('p');
            message.className = 'village-render-error';
            message.textContent = error instanceof Error ? error.message : '3Dの初期化に失敗しました。';
            el.append(message);
            // Degrade to a stage-less client rather than aborting main(): the panels,
            // feed and trial controls stay usable without WebGL2.
            console.error('StageView mount failed; continuing without the 3D village.', error);
        }
    }
    get isTrial(): boolean { return this.world?.phase === 'ten' || this.world?.phase === 'ketsu'; }
    setVillagerTapHandler(handler: ((id: string) => void) | null): void { this.tap = handler; }
    setTheme(lex: ThemeLexicon): void { this.lex = lex; }
    playerVerdict(side: 'guilty' | 'innocent'): void { this.say(side === 'guilty' ? 'あなた：厳しい裁きを求める' : 'あなた：生かして教育する道を求める'); }
    playerTestify(stance: 'accuse' | 'defend', text?: string): void { this.say(`あなたの証言：${text ?? (stance === 'accuse' ? '責任を問いたい' : 'まだ判断できない、弁護したい')}`); }
    setTrialLines(incidentId: string, lines: TrialLine[]): void {
        if (incidentId !== this.world?.incident?.id)
            return;
        this.messages.push(...lines.slice(0, 8).map((line) => `${this.name(line.speaker)}：${line.text}`));
        this.messages = this.messages.slice(-12);
    }
    setTrialVoices(incidentId: string, voices: TrialVoice[]): void {
        if (incidentId !== this.world?.incident?.id)
            return;
        for (const v of voices)
            if (!this.voiceIds.has(v.id)) {
                this.voiceIds.add(v.id);
                this.messages.push(`${v.userName ?? '観客'}：${v.text}`);
                if (v.respondentId && v.responseText)
                    this.messages.push(`${this.name(v.respondentId)}：${v.responseText}`);
            }
        this.messages = this.messages.slice(-12);
    }
    reactToAction(id: string, type: 'incite' | 'sanction' | 'cheer' | 'champion' | 'gift-treat' | 'gift-poison' | 'fanFlames'): void {
        const text = { incite: 'なんだと…！？', sanction: '言い分を聞いて！', cheer: '応援してくれてありがとう', champion: '見ていてくれるんだね', 'gift-treat': 'いい匂い！', 'gift-poison': 'うっ…何を飲ませたの？', fanFlames: '誰がそんな噂を…' }[type];
        this.say(`${this.name(id)}：${text}`);
    }
    reactToHeckle(side: 'agitate' | 'soothe'): void { this.say(side === 'agitate' ? '観客席がざわめいている…' : '落ち着いて、話を聞こう。'); }
    /**
     * Whole-town snapshot: scenery, building occupancy, story and speaker-name lookup
     * all need the full roster, which the area frame does not carry. Resident meshes
     * come from updateArea() instead.
     */
    update(world: WireWorld): void {
        const renderer = this.renderer;
        const previous = this.world;
        // Track the world even without a renderer so isTrial (and the verdict controls
        // keyed off it) stay correct on the degraded, WebGL2-less path.
        this.world = world;
        const lastArgument = world.trial?.factions?.lines.at(-1);
        if (lastArgument && world.trial?.factions?.turn !== previous?.trial?.factions?.turn) {
            this.say(`${lastArgument.side === 'accusers' ? '告発側' : '被告側'}・${this.name(lastArgument.speaker)}：${lastArgument.text}`);
        }
        if (previous?.incident?.id !== world.incident?.id) {
            this.messages = [];
            this.voiceIds.clear();
        }
        if (!renderer)
            return;
        const damagedHomes = new Set(world.villagers.flatMap((v) => v.townLife?.housing === 'displaced' && v.townLife.formerHomeId ? [v.townLife.formerHomeId] : []));
        const homesKey = JSON.stringify(world.villagers.filter((v) => v.alive && v.townLife).map((v) => [v.townLife?.homeId, v.townLife?.formerHomeId, v.townLife?.buildHomeId, mixedPartsFor(v)]));
        const sceneryKey = `${this.area}:${world.config.gridWidth}:${world.config.gridHeight}:${[...damagedHomes].sort().join(',')}:${homesKey}`;
        if (this.sceneryKey !== sceneryKey) {
            const mesh = renderer.upload(triangulate(townScenery(world, this.area, damagedHomes)));
            if (this.scenery)
                renderer.release(this.scenery);
            this.scenery = mesh;
            this.sceneryKey = sceneryKey;
        }
        this.town.update(world, this.area);
        // The camera follows the subscribed district, including during trials.
        if (!previous) this.resetCamera();
        const key = `${world.incident?.id}:${world.trial?.stage}:${world.trial?.defendant}`;
        if (this.isTrial && this.trialKey !== key) {
            this.trialKey = key;
            this.messages.unshift(world.trial?.stage === 'foolish' ? `${this.lex?.trialOpen ?? '開廷'}。記録と証言を照らし合わせよう。`
                : world.trial?.stage === 'fate' ? `${this.name(world.trial.defendant ?? '')}の責任と、裁きの先を考える。`
                    : `判決：${world.trial?.verdict === 'death' ? '死刑' : '教育へ'}。この結果が次の暮らしに残る。`);
        }
        this.story.update(world);
        if (!this.isTrial && !world.incident && this.messages.length === 0) {
            const latest = world.villagerActionLog.at(-1);
            const text = latest ? `${latest.villagerName}：${latest.text}` : '';
            if (text && text !== this.lastAmbientAction) {
                this.lastAmbientAction = text;
                this.messages.push(text);
            }
        }
    }
    /**
     * Area frame: only the residents (and their routes) inside the subscribed area.
     * The frame's world is area-filtered, so nothing here may read the global roster.
     */
    updateArea(world: WireWorld): void {
        if (this.changingScene) return;
        const renderer = this.renderer;
        if (!renderer)
            return;
        const previous = this.areaWorld;
        this.areaWorld = world;
        const regridded = previous !== null
            && (previous.config.gridWidth !== world.config.gridWidth || previous.config.gridHeight !== world.config.gridHeight);
        // The server already applied MAX_VISIBLE_RESIDENTS with story-aware ordering; this
        // slice is only a guard against an over-sized frame, and must preserve wire order.
        const residents = world.villagers.filter((v) => v.alive && (v.hiddenUntilTerm ?? -1) <= world.term)
            .slice(0, MAX_VISIBLE_RESIDENTS);
        const seen = new Set<string>();
        for (const v of residents) {
            seen.add(v.id);
            const signature = JSON.stringify([v.species, v.reformCount, mixedPartsFor(v)]);
            let visual = this.units.get(v.id);
            const defendant = world.trial?.defendant === v.id;
            const target: Vec3 = townPoint(world.config, v.position);
            const movementKey = `${this.isTrial}:${v.position.x}:${v.position.y}`;
            if (!visual) {
                const mesh = renderer.upload(triangulate(residentParts(v)));
                const label = document.createElement('button');
                label.type = 'button';
                label.onclick = () => this.tap?.(v.id);
                this.labels.append(label);
                visual = { mesh, signature, label, position: [...target], target, route: [], movementKey };
                this.units.set(v.id, visual);
            }
            else if (visual.signature !== signature) {
                const mesh = renderer.upload(triangulate(residentParts(v)));
                renderer.release(visual.mesh);
                visual.mesh = mesh;
                visual.signature = signature;
                this.say(`${v.name}の教育：${v.educationHistory?.at(-1)?.rationale ?? '外見が変化した'} → ${mixedPartsFor(v).map((p) => PART_LABELS[p]).join('・')}`);
            }
            visual.target = target;
            if (visual.movementKey !== movementKey) {
                // A regridded town invalidates every cached world-space point; snap rather
                // than interpolate across the discontinuity.
                if (regridded) {
                    visual.position = [...target];
                    visual.route = [];
                } else {
                    const route = (v.behaviorTrace?.route ?? []).map((p) => townPoint(world.config, p));
                    visual.route.push(...(route.length ? route : [target]));
                    // A background tab may lag multiple days; resync instead of replaying unbounded paths.
                    if (visual.route.length > 64) { visual.position = [...target]; visual.route = []; }
                }
                visual.movementKey = movementKey;
            }
            const awake = isAwake(v.activity, world.calendar.segment, world.config.segmentsPerDay);
            // Badges come from residentHistory, which only the global snapshot carries.
            const display = this.world ? villagerDisplayName(this.world, v) : v.name;
            visual.label.textContent = `${defendant ? '⚖ ' : ''}${display}${!awake ? ' 💤' : ''}${v.reformCount ? ` · 混${v.reformCount}` : ''}`;
            visual.label.title = v.behaviorTrace?.outputAction ?? v.emotion.label;
            visual.label.dataset['mixed'] = String(v.reformCount > 0);
            visual.label.dataset['side'] = world.trial?.factions?.accusers.includes(v.id) ? 'accusers' : world.trial?.factions?.defenders.includes(v.id) ? 'defenders' : '';
        }
        for (const [id, visual] of this.units)
            if (!seen.has(id)) {
                renderer.release(visual.mesh);
                visual.label.remove();
                this.units.delete(id);
            }
    }
    private readonly tick = (now: number): void => {
        const renderer = this.renderer;
        if (!renderer)
            return;
        const dt = Math.min(.1, Math.max(0, (now - this.lastTime) / 1000));
        this.lastTime = now;
        const night = this.world && this.world.calendar.segment / this.world.config.segmentsPerDay < 1 / 6;
        renderer.begin(this.width, this.height, night ? [.18, .24, .34] : [.68, .8, .82]);
        if (this.world) this.town.project(renderer, this.world);
        if (this.scenery)
            renderer.draw(this.scenery, [0, 0, 0]);
        // Items follow the subscribed area, matching the residents drawn beside them.
        const area = this.areaWorld;
        if (!this.isTrial && this.itemMesh && area)
            for (const item of area.items) {
                renderer.draw(this.itemMesh, townPoint(area.config, item.position));
            }
        for (const [id, visual] of this.units) {
            const waypoint = visual.route[0] ?? visual.target;
            const gap = Math.hypot(waypoint[0] - visual.position[0], waypoint[2] - visual.position[2]);
            const step = Math.min(1, dt * 5 / Math.max(.001, gap));
            for (const axis of [0, 1, 2] as const) visual.position[axis] += (waypoint[axis] - visual.position[axis]) * step;
            if (gap < .03) { visual.position = [...waypoint]; visual.route.shift(); }
            const moving = Math.hypot(visual.target[0] - visual.position[0], visual.target[2] - visual.position[2]) > .03;
            const speaking = this.world?.trial?.stage === 'foolish' && this.world.trial.factions?.lines.at(-1)?.speaker === id;
            const offset: Vec3 = [visual.position[0] + (speaking ? Math.sin(now * .025) * .05 : 0), moving || speaking ? Math.abs(Math.sin(now * .012)) * .06 : 0, visual.position[2]];
            renderer.draw(visual.mesh, offset);
            const pos = renderer.project([offset[0], 1.95, offset[2]]);
            visual.label.style.transform = `translate(${pos.x}px,${pos.y}px) translate(-50%,-50%)`;
        }
        if (now > this.speechUntil) {
            const next = this.messages.shift();
            if (next)
                this.say(next);
            else
                this.speech.hidden = true;
        }
        this.frame = requestAnimationFrame(this.tick);
    };
    private say(text: string): void { this.speech.textContent = text; this.speech.hidden = false; this.speechUntil = performance.now() + 5500; }
    private name(id: string): string { return this.world?.villagers.find((v) => v.id === id)?.name ?? id; }
    private readonly onContextLost = (event: Event): void => {
        // Drop the renderer, not just the frame loop: every later update() would
        // otherwise call upload()/draw() on a dead context and throw out of the
        // world-snapshot handler. Panels and trial controls keep working after this.
        event.preventDefault();
        cancelAnimationFrame(this.frame);
        this.renderer = null;
        this.scenery = null;
        this.itemMesh = null;
        this.sceneryKey = '';
        for (const visual of this.units.values()) visual.label.remove();
        this.units.clear();
        this.areaWorld = null;
        this.say('3D描画の接続が失われました。ページを再読み込みしてください。');
    };
    private readonly onPageHide = (event: PageTransitionEvent): void => {
        if (!event.persisted)
            this.destroy();
    };
    destroy(): void {
        this.courtTransition.destroy();
        cancelAnimationFrame(this.frame);
        this.observer?.disconnect();
        this.observer = null;
        window.removeEventListener('pagehide', this.onPageHide);
        this.renderer?.canvas.removeEventListener('webglcontextlost', this.onContextLost);
        this.renderer?.destroy();
        this.renderer = null;
        this.scenery = null;
        this.itemMesh = null;
        this.sceneryKey = '';
        this.town.destroy();
        this.world = null;
        this.areaWorld = null;
        this.trialKey = '';
        this.voiceIds.clear();
        this.messages = [];
        this.units.clear();
        this.labels.replaceChildren();
        this.controls.replaceChildren();
        for (const el of [this.labels, this.controls, this.story.root, this.speech])
            el.remove();
        this.host = null;
    }
}
