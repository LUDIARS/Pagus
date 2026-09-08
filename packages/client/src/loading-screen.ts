/** Initial loading only; subsequent reconnects remain in the existing status bar. */
export class LoadingScreen {
  private readonly root = document.getElementById('pagus-loading');
  private readonly shell = document.getElementById('app-shell');
  private readonly status = document.getElementById('loading-status');
  private readonly skip = document.getElementById('loading-skip');
  private timer: number | null = null;
  private complete = false;
  private failed = false;
  constructor() {
    this.skip?.addEventListener('click', this.dismiss);
    window.addEventListener('pagehide', this.dismiss, { once: true });
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.complete || this.failed) return;
      this.message('読み込みに時間がかかっています。接続を待つか、再読み込みしてください。');
      if (this.skip) this.skip.hidden = false;
    }, 20000);
  }
  connection(status: string): void {
    if (this.complete || this.failed) return;
    if (status === '● 接続') { this.mark('connection'); this.message('街の情報を受け取っています…'); }
    else if (status.includes('切断') || status.includes('エラー')) {
      this.message('接続できませんでした。自動で再接続しています。');
      if (this.skip) this.skip.hidden = false;
    }
  }
  snapshot(): void {
    if (this.complete || this.failed) return;
    this.mark('world'); this.message('建物と住民を描画しています…');
  }
  sceneReady(): void { if (!this.failed) { this.mark('scene'); this.dismiss(); } }
  fail(message: string): void {
    // Once the town is on screen, later failures belong to the status bar; do not
    // re-cover a dismissed loading screen (nor write into an invisible dialog).
    if (this.complete) return;
    this.failed = true; this.message(message);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (this.skip) this.skip.hidden = false;
  }
  private message(text: string): void { if (this.status) this.status.textContent = text; }
  private mark(step: string): void { document.getElementById(`loading-${step}`)?.setAttribute('data-ready', 'true'); }
  private readonly dismiss = (): void => {
    this.complete = true;
    // Read focus before hiding: hiding an element that holds focus blurs it to
    // <body>, so a post-hide contains() check would never see the loading screen.
    const hadFocus = this.root?.contains(document.activeElement) ?? false;
    if (this.root) this.root.hidden = true;
    if (this.shell) { this.shell.inert = false; this.shell.removeAttribute('aria-busy'); }
    if (hadFocus) document.getElementById('btn-left')?.focus();
    this.destroy();
  };
  private readonly destroy = (): void => {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.skip?.removeEventListener('click', this.dismiss);
    window.removeEventListener('pagehide', this.dismiss);
  };
}
