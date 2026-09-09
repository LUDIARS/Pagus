import type { Villager } from '@pagus/sim';
import { residentParts, triangulate, type ShapePart } from './resident-mesh.js';
import { PictorScene } from './pictor-scene.js';

/** One lazily owned Pictor context serves every resident thumbnail. */
export class ResidentPortraits {
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<HTMLImageElement, ShapePart[]>();
  private scene: PictorScene | null = null;
  private readonly observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target as HTMLImageElement;
      this.observer.unobserve(img);
      const parts = this.pending.get(img); this.pending.delete(img);
      if (parts) this.paint(img, JSON.stringify(parts), parts);
    }
  });
  private render(parts: ShapePart[]): string {
    const scene = this.scene ??= new PictorScene();
    const mesh = scene.upload(triangulate(parts));
    try {
      const top = Math.max(...parts.map(p=>p.center[1]+p.radius[1]));
      const bottom = Math.min(...parts.map(p=>p.center[1]-p.radius[1]));
      const radius = Math.max(...parts.map(p=>Math.abs(p.center[0])+p.radius[0]), ...parts.map(p=>Math.abs(p.center[2])+p.radius[2]), (top-bottom)/2);
      scene.focus = [0, (top+bottom)/2, 0]; scene.yaw = -.35; scene.zoom = 27/(radius*1.55);
      scene.begin(160,160,[.91,.93,.90]); scene.draw(mesh,[0,0,0]); scene.end();
      return scene.canvas.toDataURL('image/png');
    } finally { scene.release(mesh); }
  }
  private paint(img: HTMLImageElement, key: string, parts: ShapePart[]): void {
    try {
      let data = this.cache.get(key);
      if (!data) { data=this.render(parts);this.cache.set(key,data); }
      img.src=data;
      while(this.cache.size>128){const first=this.cache.keys().next().value;if(first!==undefined)this.cache.delete(first);}
    } catch(error) { img.alt=error instanceof Error?error.message:'Pictorでモデルを表示できません'; }
  }
  reset(): void { this.observer.disconnect();this.pending.clear(); }
  create(v: Villager): HTMLImageElement {
    const img=document.createElement('img');img.width=img.height=104;
    img.alt=`${v.name}の現在のモデル（教育${v.reformCount}回）`;
    img.style.cssText='float:left;margin:0 10px 4px 0;border-radius:8px;object-fit:contain';
    const parts=residentParts(v),key=JSON.stringify(parts);
    if(this.cache.has(key))this.paint(img,key,parts);
    else{this.pending.set(img,parts);this.observer.observe(img);}
    return img;
  }
  destroy(): void { this.reset();this.cache.clear();this.scene?.destroy();this.scene=null; }
}
