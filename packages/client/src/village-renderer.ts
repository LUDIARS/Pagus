import type { Vec3 } from './resident-mesh.js';
export interface VillageMesh {
    buffer: WebGLBuffer;
    count: number;
}
const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 color;
uniform vec3 offset;
uniform vec2 scale;
uniform float yaw;
uniform vec3 focus;
out vec3 world;
out vec3 tint;
void main() {
  world = position + offset;
  vec3 relative = world - focus;
  float x = cos(yaw)*relative.x - sin(yaw)*relative.z;
  float z = sin(yaw)*relative.x + cos(yaw)*relative.z;
  // Depth grows with view distance so the default depthFunc(LESS) keeps the
  // nearest fragment. Negating it here would let far geometry overdraw near.
  gl_Position = vec4(x/scale.x, (relative.y*.866-z*.5)/scale.y, (z*.866+relative.y*.5)/100., 1.);
  tint = color;
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec3 world;
in vec3 tint;
out vec4 pixel;
void main() {
  vec3 normal = normalize(cross(dFdx(world), dFdy(world)));
  float light = .50 + .50*abs(dot(normal, normalize(vec3(-.4, .8, .5))));
  pixel = vec4(tint*light, 1.);
}`;
/** Owns one WebGL context and every GPU allocation, including failed initialization paths. */
export class VillageRenderer {
    readonly canvas = document.createElement('canvas');
    private readonly gl: WebGL2RenderingContext;
    private readonly program: WebGLProgram;
    private readonly meshes = new Set<VillageMesh>();
    private readonly uniforms: {
        offset: WebGLUniformLocation;
        scale: WebGLUniformLocation;
        yaw: WebGLUniformLocation;
        focus: WebGLUniformLocation;
    };
    yaw = -0.2;
    zoom = 1;
    focus: Vec3 = [0, 0, 0];
    private scaleX = 12;
    private scaleY = 12;
    private width = 1;
    private height = 1;
    constructor() {
        const gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false });
        if (!gl)
            throw new Error('3Dの村を表示するには WebGL2 が必要です。ブラウザのハードウェアアクセラレーションを確認してください。');
        this.gl = gl;
        const program = gl.createProgram();
        if (!program)
            throw new Error('3D描画プログラムを確保できません。');
        const shaders: WebGLShader[] = [];
        try {
            for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
                const shader = gl.createShader(type);
                if (!shader)
                    throw new Error('シェーダーを確保できません。');
                shaders.push(shader);
                gl.shaderSource(shader, source);
                gl.compileShader(shader);
                if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                    throw new Error(gl.getShaderInfoLog(shader) ?? '3Dシェーダーエラー');
                gl.attachShader(program, shader);
            }
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS))
                throw new Error(gl.getProgramInfoLog(program) ?? '3Dリンクエラー');
            const location = (name: string): WebGLUniformLocation => {
                const loc = gl.getUniformLocation(program, name);
                if (loc === null)
                    throw new Error(`3D uniform missing: ${name}`);
                return loc;
            };
            this.uniforms = { offset: location('offset'), scale: location('scale'), yaw: location('yaw'), focus: location('focus') };
            this.program = program;
        }
        catch (error) {
            gl.deleteProgram(program);
            throw error;
        }
        finally {
            shaders.forEach((shader) => gl.deleteShader(shader));
        }
    }
    upload(vertices: Float32Array): VillageMesh {
        const gl = this.gl;
        const buffer = gl.createBuffer();
        if (!buffer)
            throw new Error('3Dメッシュを確保できません。');
        try {
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
            if (gl.getError() !== gl.NO_ERROR)
                throw new Error('3Dメッシュの転送に失敗しました。');
            const mesh = { buffer, count: vertices.length / 6 };
            this.meshes.add(mesh);
            return mesh;
        }
        catch (error) {
            gl.deleteBuffer(buffer);
            throw error;
        }
    }
    release(mesh: VillageMesh): void {
        if (this.meshes.delete(mesh))
            this.gl.deleteBuffer(mesh.buffer);
    }
    begin(width: number, height: number, background: Vec3): void {
        this.width = Math.max(1, width);
        this.height = Math.max(1, height);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.round(this.width * dpr), h = Math.round(this.height * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        this.scaleY = Math.max(16, 27 * this.height / this.width) / this.zoom;
        this.scaleX = this.scaleY * this.width / this.height;
        const gl = this.gl;
        gl.viewport(0, 0, w, h);
        gl.clearColor(...background, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.useProgram(this.program);
        gl.uniform2f(this.uniforms.scale, this.scaleX, this.scaleY);
        gl.uniform1f(this.uniforms.yaw, this.yaw);
        gl.uniform3f(this.uniforms.focus, ...this.focus);
    }
    draw(mesh: VillageMesh, offset: Vec3): void {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        gl.uniform3f(this.uniforms.offset, ...offset);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    }
    project([x, y, z]: Vec3): {
        x: number;
        y: number;
    } {
        x -= this.focus[0]; y -= this.focus[1]; z -= this.focus[2];
        const xx = Math.cos(this.yaw) * x - Math.sin(this.yaw) * z;
        const zz = Math.sin(this.yaw) * x + Math.cos(this.yaw) * z;
        return { x: (xx / this.scaleX + 1) * this.width / 2, y: (1 - (y * .866 - zz * .5) / this.scaleY) * this.height / 2 };
    }
    destroy(): void {
        for (const mesh of this.meshes)
            this.release(mesh);
        this.gl.deleteProgram(this.program);
        this.gl.getExtension('WEBGL_lose_context')?.loseContext();
        this.canvas.remove();
    }
}
