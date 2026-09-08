/** Owns the edge wipe and cancellation when another scene supersedes it. */
export class CourtTransition {
  readonly element = document.createElement('div');
  private animation: Animation | null = null;
  private generation = 0;
  constructor() { this.element.className = 'court-wipe'; }
  async run(changeScene: () => void): Promise<void> {
    const generation = ++this.generation;
    this.animation?.cancel();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { changeScene(); return; }
    try {
      this.element.style.transformOrigin = 'left';
      this.animation = this.element.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 240, fill: 'forwards', easing: 'ease-in' });
      await this.animation.finished;
      if (generation !== this.generation) return;
      changeScene();
      this.animation.cancel();
      this.element.style.transformOrigin = 'right';
      this.animation = this.element.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: 320, fill: 'forwards', easing: 'ease-out' });
      await this.animation.finished;
      if (generation === this.generation) { this.animation.cancel(); this.animation = null; }
    } catch { /* Superseded scenes and page teardown intentionally cancel the animation. */ }
  }
  destroy(): void { this.generation++; this.animation?.cancel(); this.animation = null; this.element.remove(); }
}
