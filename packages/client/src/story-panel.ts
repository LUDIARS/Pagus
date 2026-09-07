import { visibleStoryEvidence, type WireWorld } from '@pagus/sim';
export class StoryPanel {
    readonly root = document.createElement('details');
    private key = '';
    constructor() { this.root.className = 'village-story'; }
    update(world: WireWorld): void {
        const inc = world.incident;
        const evidence = inc ? visibleStoryEvidence(inc, world.trial?.stage) : [];
        const title = inc?.story?.title ?? (inc ? '村で起きていること' : world.narrative?.beat === 'recovery' ? '裁きのあとで' : world.narrative?.beat === 'omen' ? '何かの予兆' : '村の一日');
        const lines = inc ? [inc.story?.setup ?? inc.description, inc.story?.question,
            ...evidence.map((e) => `記録・証言「${e.title}」：${e.account}`),
            ...inc.steps.slice(-2).map((s) => `${s.perspective === 'victim' ? '関係者' : '当事者'}の経過：${s.action}`),
            ...(world.trial?.witnesses ?? []).map((w) => `${w.name}の証言：${w.line}`),
            world.trial?.reveal ? `逆転：被告が${world.trial.reveal.fromName}から${world.trial.reveal.toName}へ変更された。` : null,
            world.trial?.verdict ? `判決：${world.trial.verdict === 'death' ? '死刑' : '生かして教育へ'}。${inc.story?.stakes ?? ''}` : inc.story?.stakes,
        ] : [world.narrative?.text ?? '住民を選ぶと、目的・教育の変化・行動の理由を確認できます。'];
        const key = JSON.stringify([title, lines]);
        if (key === this.key)
            return;
        this.key = key;
        this.root.replaceChildren();
        const summary = document.createElement('summary');
        summary.textContent = `${title} — 経緯を読む`;
        this.root.append(summary);
        for (const text of lines)
            if (text) {
                const p = document.createElement('p');
                p.textContent = text;
                this.root.append(p);
            }
    }
}
