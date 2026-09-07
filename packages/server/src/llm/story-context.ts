import { visibleStoryEvidence, type Incident } from '@pagus/sim';
export function storyContext(incident: Incident, stage: 'foolish' | 'fate' | 'decided'): string {
    if (!incident.story)
        return '';
    return `争点: ${incident.story.question}\n記録・証言（断定された事実とは限らない）:\n` +
        visibleStoryEvidence(incident, stage).map((record) => `- ${record.title}: ${record.account}`).join('\n') +
        `\n裁きの先: ${incident.story.stakes}\n外見の異形・教育回数だけを犯行の証拠にしない。\n`;
}
