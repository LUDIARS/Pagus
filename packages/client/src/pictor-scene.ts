import { PictorRenderer, type PictorMesh } from '@ludiars/pictor-browser';
import type { Vec3 } from './mesh-primitives.js';

/** Pagus camera/composition adapter. Pictor alone owns shaders and GPU resources. */
export class PictorScene {
    readonly canvas = document.createElement('canvas');
    private readonly renderer = new PictorRenderer(this.canvas);
    yaw = -.2;
    zoom = 1;
    focus: Vec3 = [0, 0, 0];
    private width = 1;
    private height = 1;
    private readonly projection = new Float32Array(16);
    private readonly model = new Float32Array(16);
    private get scaleY(): number { return Math.max(16, 27 * this.height / this.width) / this.zoom; }
    private get scaleX(): number { return this.scaleY * this.width / this.height; }
    upload(vertices: Float32Array): PictorMesh { return this.renderer.createMesh(vertices); }
    release(mesh: PictorMesh): void { this.renderer.releaseMesh(mesh); }
    begin(width: number, height: number, background: Vec3): void {
        this.width = Math.max(1, width); this.height = Math.max(1, height);
        const c = Math.cos(this.yaw), s = Math.sin(this.yaw), sx = this.scaleX, sy = this.scaleY;
        const [x, y, z] = this.focus, m = this.projection;
        m.set([c/sx, -s*.5/sy, s*.866/100, 0, 0, .866/sy, .5/100, 0,
            -s/sx, -c*.5/sy, c*.866/100, 0,
            (-c*x+s*z)/sx, (-y*.866+(s*x+c*z)*.5)/sy, (-(s*x+c*z)*.866-y*.5)/100, 1]);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        this.renderer.beginFrame({ width: Math.max(1, Math.round(width*dpr)), height: Math.max(1, Math.round(height*dpr)), viewProjection: m, clearColor: background });
    }
    draw(mesh: PictorMesh, offset: Vec3, heading = 0, size = 1, phase = 0, stride = 0): void {
        const c = Math.cos(heading)*size, s = Math.sin(heading)*size;
        // Animation is scene data; the renderer receives only a model transform.
        const lean = Math.sin(phase)*stride*.12;
        this.model.set([c, 0, -s, 0, lean, size, 0, 0, s, 0, c, 0, ...offset, 1]);
        this.renderer.submit({ mesh, transform: this.model });
    }
    end(): void { this.renderer.endFrame(); }
    project([x, y, z]: Vec3): { x: number; y: number } {
        x -= this.focus[0]; y -= this.focus[1]; z -= this.focus[2];
        const xx = Math.cos(this.yaw)*x - Math.sin(this.yaw)*z;
        const zz = Math.sin(this.yaw)*x + Math.cos(this.yaw)*z;
        return { x: (xx/this.scaleX+1)*this.width/2, y: (1-(y*.866-zz*.5)/this.scaleY)*this.height/2 };
    }
    groundAt(x: number, y: number): Vec3 {
        const xx = (x/this.width*2-1)*this.scaleX;
        const zz = -(1-y/this.height*2)*this.scaleY*2;
        return [this.focus[0]+Math.cos(this.yaw)*xx+Math.sin(this.yaw)*zz, this.focus[1],
            this.focus[2]-Math.sin(this.yaw)*xx+Math.cos(this.yaw)*zz];
    }
    destroy(): void { this.renderer.dispose(); this.canvas.remove(); }
}
export type { PictorMesh };
