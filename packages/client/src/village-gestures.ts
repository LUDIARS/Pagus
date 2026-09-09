import type { PictorScene } from './pictor-scene.js';

/** Canvas pointer lifetime: one-finger pan and anchored two-finger pinch. */
export class VillageGestures {
    private readonly points = new Map<number, { x: number; y: number }>();
    private readonly abort = new AbortController();
    constructor(private readonly scene: PictorScene, private readonly changed: () => void) {
        const canvas = scene.canvas, options = { signal: this.abort.signal };
        canvas.style.touchAction = 'none';
        canvas.addEventListener('pointerdown', this.down, options);
        canvas.addEventListener('pointermove', this.move, options);
        canvas.addEventListener('pointerup', this.up, options);
        canvas.addEventListener('pointercancel', this.up, options);
        canvas.addEventListener('lostpointercapture', this.up, options);
        canvas.addEventListener('wheel', this.wheel, { ...options, passive: false });
    }
    private point(e: { clientX: number; clientY: number }): { x: number; y: number } {
        const rect = this.scene.canvas.getBoundingClientRect();
        return { x: e.clientX-rect.left, y: e.clientY-rect.top };
    }
    private readonly down = (e: PointerEvent): void => {
        if (e.button !== 0 || this.points.size >= 2) return;
        this.points.set(e.pointerId, this.point(e)); this.scene.canvas.setPointerCapture(e.pointerId);
    };
    private frame(): { x: number; y: number; distance: number } {
        const [a, b] = [...this.points.values()];
        if (!a) throw new Error('No active camera pointer');
        return b ? { x: (a.x+b.x)/2, y: (a.y+b.y)/2, distance: Math.hypot(a.x-b.x, a.y-b.y) } : { ...a, distance: 0 };
    }
    private readonly move = (e: PointerEvent): void => {
        if (!this.points.has(e.pointerId)) return;
        e.preventDefault();
        const before = this.frame(), anchor = this.scene.groundAt(before.x, before.y);
        this.points.set(e.pointerId, this.point(e)); const after = this.frame();
        if (before.distance > 1 && after.distance > 1) this.scene.zoom = Math.max(.7, Math.min(8, this.scene.zoom*after.distance/before.distance));
        const destination = this.scene.groundAt(after.x, after.y);
        this.scene.focus[0] += anchor[0]-destination[0]; this.scene.focus[2] += anchor[2]-destination[2];
        this.finish();
    };
    private readonly up = (e: PointerEvent): void => {
        this.points.delete(e.pointerId);
        if (this.scene.canvas.hasPointerCapture(e.pointerId)) this.scene.canvas.releasePointerCapture(e.pointerId);
    };
    private readonly wheel = (e: WheelEvent): void => {
        e.preventDefault(); const p = this.point(e), anchor = this.scene.groundAt(p.x, p.y);
        this.scene.zoom = Math.max(.7, Math.min(8, this.scene.zoom*Math.exp(-e.deltaY*.001)));
        const destination = this.scene.groundAt(p.x, p.y);
        this.scene.focus[0] += anchor[0]-destination[0]; this.scene.focus[2] += anchor[2]-destination[2]; this.finish();
    };
    private finish(): void {
        this.scene.focus[0] = Math.max(-18, Math.min(18, this.scene.focus[0]));
        this.scene.focus[2] = Math.max(-18, Math.min(18, this.scene.focus[2]));
        this.changed();
    }
    destroy(): void {
        this.abort.abort();
        for (const id of this.points.keys()) if (this.scene.canvas.hasPointerCapture(id)) this.scene.canvas.releasePointerCapture(id);
        this.points.clear();
    }
}
