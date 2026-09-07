import type { Incident, MoralDial, World } from './types/index.js';
import { aliveVillagers } from './world.js';
export interface StoryEvidence {
    title: string;
    account: string;
    stage: 'opening' | 'hearing';
}
export interface StoryCase {
    title: string;
    setup: string;
    question: string;
    evidence: StoryEvidence[];
    stakes: string;
}
export interface NarrativeState {
    quietTicks: number;
    lastTick: string;
    recoveryUntil: number;
    episode: number;
    ordinaryIncidents: number;
    beat: 'calm' | 'omen' | 'incident' | 'recovery';
    text: string;
    /** Term the current omen was raised on. Bounds how long it may suppress incidents. */
    omenTerm?: number;
}
export function narrativeState(world: World): NarrativeState {
    return world.narrative ??= { quietTicks: 0, lastTick: '', recoveryUntil: world.term,
        episode: 0, ordinaryIncidents: 0, beat: 'calm', text: '住民の日課を見守る時間。小さな関係が次の物語を育てる。' };
}
/** Count simulation segments, not frames or connections. Never replace an active case. */
export function advanceNarrative(world: World, moral: MoralDial): {
    perpetrator: string;
    involved: string[];
    story: StoryCase;
} | null {
    const state = narrativeState(world);
    const key = `${world.term}:${world.calendar.segment}`;
    if (state.lastTick === key || world.incident || world.trial)
        return null;
    state.lastTick = key;
    if (world.term < state.recoveryUntil)
        return null;
    state.quietTicks += 1;
    const threshold = world.config.segmentsPerDay + state.episode % 3;
    if (state.quietTicks < Math.floor(threshold / 2) && state.ordinaryIncidents < 3) {
        state.beat = 'calm';
        return null;
    }
    if (state.beat !== 'omen') {
        state.beat = 'omen';
        state.omenTerm = world.term;
        state.text = '広場に封の破れた招待状が落ちている。誰かが、前の裁きについて話したがっている。';
        return null; // The omen gets at least one full simulation segment before the incident.
    }
    if (state.quietTicks < threshold && state.ordinaryIncidents < 3)
        return null;
    const residents = aliveVillagers(world).sort((a, b) => a.id.localeCompare(b.id));
    if (residents.length < 3) {
        // Too few residents to cast a story case. Release the omen so ordinary
        // incidents are not suppressed indefinitely by applyDecision.
        state.beat = 'calm';
        state.quietTicks = 0;
        return null;
    }
    const offset = state.episode % residents.length;
    const accused = residents[offset];
    const other = residents[(offset + 1) % residents.length];
    const witness = residents[(offset + 2) % residents.length];
    if (!accused || !other || !witness)
        return null;
    const reform = accused.educationHistory?.at(-1);
    const motive = reform ? `前の教育「${reform.rationale}」をめぐる約束` : '旅商人に預けた大切な品の返却';
    const murder = state.episode % 2 === 0 && moral !== 'wholesome';
    const story: StoryCase = murder ? {
        title: '灯の消えた晩餐会',
        setup: `招待された旅商人が食堂で亡くなった。${accused.name}と${other.name}には、それぞれ会う理由があった。`,
        question: '誰が最後の一杯を運んだのか。食堂にいたことだけで、犯人と決められるか。',
        evidence: [
            { title: '食堂の配膳帳', account: `${accused.name}が最後の一杯を運んだ記録がある。記入者はまだ確かめられていない。`, stage: 'opening' },
            { title: '招待状の余白', account: `${other.name}は「${motive}について、今夜話したい」と書いていた。動機と実行は別の問題だ。`, stage: 'opening' },
            { title: '目撃の食い違い', account: `${witness.name}は消灯前に杯が交換されたと証言した。配膳した時刻と、交換した時刻を分けて考える必要がある。`, stage: 'hearing' },
        ],
        stakes: '裁きで誰かを失えば、その人との約束も失われる。教育なら、何を変え何を残すのか。',
    } : {
        title: moral === 'wholesome' ? '消えた祝祭の贈り物' : '教育された証人の裁判',
        setup: `${other.name}が大切な品を失い、${accused.name}を告発した。争点は${motive}。`,
        question: '持ち去ったのか、守るために預かったのか。村が教えた価値観の責任は誰が負うのか。',
        evidence: [
            { title: '預かり証', account: `${accused.name}の署名があるが返却期限の欄が空白になっている。`, stage: 'opening' },
            { title: '当事者の約束', account: `${other.name}は「祭りが終わるまで」と頼んだという。依頼の条件が争われている。`, stage: 'opening' },
            { title: '証人が覚えていた言葉', account: `${witness.name}は「危険がなくなるまで守れ」と教えられたと証言した。善意と所有権が衝突している。`, stage: 'hearing' },
        ],
        stakes: '処罰だけでは約束の食い違いは消えない。次の暮らしで守るルールを選ぶ裁判。',
    };
    state.episode += 1;
    state.quietTicks = 0;
    state.ordinaryIncidents = 0;
    state.beat = 'incident';
    state.text = story.title;
    return { perpetrator: accused.id, involved: [other.id, witness.id], story };
}
export function rememberIncident(world: World, incident: Incident): void {
    const state = narrativeState(world);
    state.ordinaryIncidents += 1;
    state.quietTicks = 0;
    state.beat = 'incident';
    state.text = incident.story?.title ?? incident.description;
}
export function beginAftermath(world: World, text: string): void {
    const state = narrativeState(world);
    state.recoveryUntil = world.term + 2;
    state.quietTicks = 0;
    state.beat = 'recovery';
    state.text = text;
}
/**
 * Whether the narrative beat currently holds back organic (non-forced) incidents.
 * The omen only suppresses on the term it was raised, so a stale beat — e.g. a day
 * where advanceNarrative never runs because a trial already opened — cannot freeze
 * the incident economy indefinitely.
 */
export function suppressesOrganicIncident(world: World): boolean {
    const state = world.narrative;
    if (!state) return false;
    if (world.term < state.recoveryUntil) return true;
    return state.beat === 'omen' && state.omenTerm === world.term;
}
/** Present accounts in hearing order; these are claims, not forensic proof. */
export function visibleStoryEvidence(incident: Incident, stage: string | undefined): StoryEvidence[] {
    return (incident.story?.evidence ?? []).filter((e) => e.stage === 'opening' || stage === 'fate' || stage === 'decided');
}
