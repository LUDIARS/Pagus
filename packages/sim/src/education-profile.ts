import type { Appearance, Reform, Villager } from './types/index.js';
import type { Personality } from './personality.js';
export type EducationDirection = 'empathy' | 'discipline' | 'curiosity' | 'ambition';
export type MixedPart = 'tentacles' | 'eyes' | 'teapot' | 'clockwork' | 'hybrid' | 'slime' | 'extraArms' | 'cthulhu';
export interface EducationMark {
    term: number;
    direction: EducationDirection;
    part: MixedPart;
    rationale: string;
    before: Appearance;
    after: Appearance;
    beforeTraits: Personality;
    afterTraits: Personality;
}
export const PART_LABELS: Record<MixedPart, string> = {
    tentacles: '共感する触手', eyes: '禁書を覗く第三の目', teapot: '欲望のティーポット', clockwork: '規律のぜんまい',
    hybrid: '別種の頭', slime: 'スライムの体', extraArms: '四本の腕', cthulhu: '深淵の触手',
};
export const DIRECTION_LABELS: Record<EducationDirection, string> = {
    empathy: '共感', discipline: '規律', curiosity: '探究', ambition: '欲望',
};
/** Education outcomes, rather than a random cosmetic roll, determine both anatomy and policy. */
export function educationDirection(before: Personality, after: Personality): EducationDirection {
    const choices: Array<[
        EducationDirection,
        number
    ]> = [
        ['empathy', after.kindness - before.kindness + before.aggression - after.aggression],
        ['discipline', after.discipline - before.discipline],
        ['curiosity', after.curiosity - before.curiosity],
        ['ambition', after.ambition - before.ambition],
    ];
    const [best] = choices.sort((a, b) => b[1] - a[1]);
    // A Reform may legally carry no persona.traits, leaving every delta at 0. Reporting
    // '共感' there would claim a kindness shift that never happened, so fall back to the
    // neutral outcome instead of whichever direction happens to sort first on the tie.
    if (!best || best[1] <= 0) return 'curiosity';
    return best[0];
}
export function recordEducation(v: Villager, reform: Extract<Reform, {
    kind: 'educate';
}>, term: number, before: Appearance, beforeTraits: Personality): EducationMark {
    const direction = reform.direction ?? educationDirection(beforeTraits, v.persona.traits);
    const parts: Record<EducationDirection, MixedPart[]> = {
        empathy: ['tentacles', 'slime'], discipline: ['clockwork', 'extraArms'], curiosity: ['eyes', 'cthulhu'], ambition: ['teapot', 'hybrid'],
    };
    const variants = parts[direction];
    const current = mixedPartsFor(v);
    const part = variants.find((candidate) => !current.includes(candidate)) ?? variants[0];
    if (!part)
        throw new Error('Education direction has no anatomy variant');
    v.appearance.descriptors = [...new Set([...v.appearance.descriptors, PART_LABELS[part]])];
    const mark: EducationMark = {
        term, direction, part, rationale: reform.rationale, before, beforeTraits,
        after: { ...v.appearance, descriptors: [...v.appearance.descriptors] },
        afterTraits: { ...v.persona.traits },
    };
    // Keep the complete part set separately when the explanatory history rolls over.
    v.mixedParts = [...new Set([...mixedPartsFor(v), part])];
    v.educationHistory = [...(v.educationHistory ?? []), mark].slice(-12);
    return mark;
}
/** Terms an education restrains behaviour before the resident may act on impulse again. */
export const EDUCATION_GATE_TERMS = 6;
/**
 * Whether a resident's most recent education still restrains them, as of `term`.
 *
 * Deliberately *not* a trait comparison. `educationTree` picks 'empathy' exactly when
 * aggression > kindness and then applies a +0.4 relative swing, so `kindness > aggression`
 * is guaranteed afterwards and nothing in the sim raises aggression back — a trait gate
 * would silence every spared resident forever and drain the 事件→裁判→教育 loop.
 * Recency bounds it instead: each new lesson restrains again, and stress wears it off sooner.
 */
export function educationHolds(v: Villager, term: number): boolean {
    const last = v.educationHistory?.at(-1);
    if (!last) return false;
    return term - last.term + Math.floor(v.stress / 4) < EDUCATION_GATE_TERMS;
}
export function mixedPartsFor(v: Villager): MixedPart[] {
    // An explicit empty array still means "no recorded parts" only once education has
    // run; before that it must fall through to the legacy descriptor reading.
    if (v.mixedParts?.length)
        return v.mixedParts;
    // Legacy educated residents have no cause record; interpret only known appearance descriptors.
    return (Object.keys(PART_LABELS) as MixedPart[]).filter((part) => v.appearance.descriptors.includes(PART_LABELS[part]));
}
/** Alternate forms carry the same education policy as their first-stage anatomy. */
export function educationPartsFor(v: Villager): MixedPart[] {
    const parts = [...mixedPartsFor(v)];
    const aliases: Partial<Record<MixedPart, MixedPart>> = { slime: 'tentacles', extraArms: 'clockwork', cthulhu: 'eyes', hybrid: 'teapot' };
    for (const part of [...parts]) {
        const alias = aliases[part];
        if (alias && !parts.includes(alias))
            parts.push(alias);
    }
    return parts;
}
export function residentHeadSpecies(v: Villager): string {
    if (!mixedPartsFor(v).includes('hybrid'))
        return v.species;
    const others = ['猫', '兎', '梟', '熊', '栗鼠', '鼯鼠', '蛇'].filter((species) => species !== v.species);
    const hash = [...v.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
    return others[hash % others.length] ?? '兎';
}
