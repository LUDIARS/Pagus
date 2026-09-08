interface CourtUtterance {
    key: string;
    speaker: string;
    name: string;
    text: string;
    side: string;
}

/** Sequential testimony presentation; only authoritative lines enter the queue. */
export class TrialDialogue {
    readonly element = document.createElement('aside');
    private readonly name = document.createElement('strong');
    private readonly text = document.createElement('p');
    private readonly seen = new Set<string>();
    private readonly queue: CourtUtterance[] = [];
    private incident: string | null = null;
    private until = 0;
    private animation: Animation | null = null;
    speaker: string | null = null;
    constructor() {
        this.element.className = 'court-dialogue';
        this.element.setAttribute('aria-live', 'polite');
        this.element.append(this.name, this.text);
        this.element.hidden = true;
    }
    reset(incident: string | null): void {
        if (this.incident === incident) return;
        this.incident = incident;
        this.queue.length = 0;
        this.seen.clear();
        this.speaker = null;
        this.until = 0;
        this.animation?.cancel();
        this.animation = null;
        this.element.hidden = true;
    }
    enqueue(line: CourtUtterance): void {
        if (this.seen.has(line.key)) return;
        this.seen.add(line.key);
        this.queue.push(line);
    }
    tick(now: number): void {
        if (now < this.until) return;
        const line = this.queue.shift();
        if (!line) { this.speaker = null; this.element.hidden = true; return; }
        this.speaker = line.speaker;
        this.name.textContent = `${line.side} · ${line.name}`;
        this.text.textContent = line.text;
        this.element.dataset['side'] = line.side;
        this.element.hidden = false;
        this.until = now + Math.min(6500, Math.max(2800, line.text.length * 85));
        this.animation?.cancel();
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches)
            this.animation = this.element.animate([{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 200 });
    }
    destroy(): void { this.reset(null); this.animation?.cancel(); this.element.remove(); }
}
