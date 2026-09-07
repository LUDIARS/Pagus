import { isAwake, mixedPartsFor, PART_LABELS, type WireWorld, type TrialLine, type TrialVoice, type ThemeLexicon } from '@pagus/sim';
import { residentParts, triangulate, type Vec3 } from './resident-mesh.js';
import { VillageRenderer, type VillageMesh } from './village-renderer.js';
import { townScenery } from './town-scenery.js';
import { townPoint } from './town-coordinates.js';
import { TownLabels } from './town-labels.js';
import { townMap, townSite } from '@pagus/sim';
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
            this.town.onFocus = (position) => { if (this.renderer) { this.renderer.focus = position; this.renderer.zoom = Math.max(1.5, this.renderer.zoom); } };
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
                            this.renderer.zoom = Math.min(2.5, this.renderer.zoom + .2);
                    }],
                ['−', () => {
                        if (this.renderer)
                            this.renderer.zoom = Math.max(.7, this.renderer.zoom - .2);
                    }],
                ['⌂', () => { if (this.renderer) { this.renderer.focus = [0, 0, 0]; this.renderer.zoom = 1; this.renderer.yaw = -.2; } }],
            ] as const) {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = label;
                b.setAttribute('aria-label', label === '↶' ? '左へ回転' : label === '↷' ? '右へ回転' : label === '＋' ? '拡大' : label === '⌂' ? '街全体を表示' : '縮小');
                b.onclick = action;
                this.controls.append(b);
            }
            el.append(this.renderer.canvas, this.town.root, this.labels, this.controls, this.town.detail, this.story.root, this.speech);
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
    update(world: WireWorld): void {
        const renderer = this.renderer;
        const previous = this.world;
        // Track the world even without a renderer so isTrial (and the verdict controls
        // keyed off it) stay correct on the degraded, WebGL2-less path.
        this.world = world;
        if (!renderer)
            return;
        const damagedHomes = new Set(world.villagers.flatMap((v) => v.townLife?.housing === 'displaced' && v.townLife.formerHomeId ? [v.townLife.formerHomeId] : []));
        const sceneryKey = `${world.config.gridWidth}:${world.config.gridHeight}:${[...damagedHomes].sort().join(',')}`;
        if (this.sceneryKey !== sceneryKey) {
            const mesh = renderer.upload(triangulate(townScenery(world.config, damagedHomes)));
            if (this.scenery)
                renderer.release(this.scenery);
            this.scenery = mesh;
            this.sceneryKey = sceneryKey;
        }
        this.town.update(world);
        const previousTrial = previous?.phase === 'ten' || previous?.phase === 'ketsu';
        if (this.isTrial && !previousTrial) {
            renderer.focus = townPoint(world.config, townSite(townMap(world.config), 'fountain').entrance);
            renderer.zoom = 2;
        } else if (!this.isTrial && previousTrial) {
            renderer.focus = [0, 0, 0]; renderer.zoom = 1;
        }
        if (previous?.incident?.id !== world.incident?.id) {
            this.messages = [];
            this.voiceIds.clear();
        }
        const residents = world.villagers.filter((v) => v.alive && (v.hiddenUntilTerm ?? -1) <= world.term);
        const seen = new Set<string>();
        for (const [i, v] of residents.entries()) {
            seen.add(v.id);
            const signature = JSON.stringify([v.species, v.reformCount, mixedPartsFor(v)]);
            let visual = this.units.get(v.id);
            const defendant = world.trial?.defendant === v.id;
            const angle = i / Math.max(1, residents.length) * Math.PI * 2;
            const plaza = townPoint(world.config, townSite(townMap(world.config), 'fountain').entrance);
            const target: Vec3 = this.isTrial ? (defendant ? [plaza[0], 0, plaza[2] + 1] : [plaza[0] + Math.cos(angle) * 2.7, 0, plaza[2] + 1 + Math.sin(angle) * 1.2])
                : townPoint(world.config, v.position);
            const movementKey = `${this.isTrial}:${world.term}:${world.calendar.segment}:${v.position.x}:${v.position.y}`;
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
                // Trial staging is presentation-only. Returning restores authoritative position.
                const wasTrial = previous?.phase === 'ten' || previous?.phase === 'ketsu';
                if (this.isTrial || wasTrial || previous?.config.gridWidth !== world.config.gridWidth || previous?.config.gridHeight !== world.config.gridHeight) {
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
            visual.label.textContent = `${defendant ? '⚖ ' : ''}${villagerDisplayName(world, v)}${!awake ? ' 💤' : ''}${v.reformCount ? ` · 混${v.reformCount}` : ''}`;
            visual.label.title = v.behaviorTrace?.outputAction ?? v.emotion.label;
            visual.label.dataset['mixed'] = String(v.reformCount > 0);
        }
        for (const [id, visual] of this.units)
            if (!seen.has(id)) {
                renderer.release(visual.mesh);
                visual.label.remove();
                this.units.delete(id);
            }
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
        if (!this.isTrial && this.itemMesh && this.world)
            for (const item of this.world.items) {
                renderer.draw(this.itemMesh, townPoint(this.world.config, item.position));
            }
        for (const visual of this.units.values()) {
            const waypoint = visual.route[0] ?? visual.target;
            const gap = Math.hypot(waypoint[0] - visual.position[0], waypoint[2] - visual.position[2]);
            const step = Math.min(1, dt * 5 / Math.max(.001, gap));
            for (const axis of [0, 1, 2] as const) visual.position[axis] += (waypoint[axis] - visual.position[axis]) * step;
            if (gap < .03) { visual.position = [...waypoint]; visual.route.shift(); }
            const moving = Math.hypot(visual.target[0] - visual.position[0], visual.target[2] - visual.position[2]) > .03;
            const offset: Vec3 = [visual.position[0], moving ? Math.abs(Math.sin(now * .012)) * .06 : 0, visual.position[2]];
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
        this.say('3D描画の接続が失われました。ページを再読み込みしてください。');
    };
    private readonly onPageHide = (event: PageTransitionEvent): void => {
        if (!event.persisted)
            this.destroy();
    };
    destroy(): void {
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
