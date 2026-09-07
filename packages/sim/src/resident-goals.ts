import type { ActionDecision } from './brain.js';
import type { GridPos, Villager, World } from './types/index.js';
import { routineGoal, townRoutine } from './town-routine.js';
import { townMap } from './town-map.js';
import { townRoute } from './town-navigation.js';
import { educationHolds, educationPartsFor } from './education-profile.js';
import { aliveVillagers, clampPos } from './world.js';
import { branch, leaf, selector } from './behavior-tree.js';
import { decideWithTree } from './resident-bt-trace.js';
import { currentIntervention } from './resident-interventions.js';
import { townSite } from './town-map.js';
export interface ResidentGoal {
    kind: 'care' | 'investigate' | 'collect' | 'work' | 'social' | 'rest';
    label: string;
    destination: GridPos;
    priority: number;
    interrupted: boolean;
}
export interface BehaviorTrace {
    route?: GridPos[];
    goal: ResidentGoal;
    proposedAction: string;
    outputAction: string;
    gate: string | null;
}
/** Reactive priority selector: the clock selects a routine, education can preempt it. */
export function selectResidentGoal(world: World, v: Villager): ResidentGoal {
    const parts = educationPartsFor(v);
    const routine = routineGoal(world, v);
    const nearby = aliveVillagers(world).filter((n) => n.id !== v.id);
    const distressed = nearby.filter((n) => (n.emotion.axes['fear'] ?? 0) > 0.4 || (n.emotion.axes['anger'] ?? 0) > 0.6)
        .sort((a, b) => distance(v.position, a.position) - distance(v.position, b.position))[0];
    const defiled = world.placeStates.find((p) => p.state === 'defiled');
    const item = [...world.items].sort((a, b) => distance(v.position, a.position) - distance(v.position, b.position))[0];
    const input = currentIntervention(world, v);
    const map = townMap(world.config);
    return decideWithTree(v, 'goal', selector<World, ResidentGoal>('goal', [
        branch('rest-or-isolation', () => routine.kind === 'rest' || v.townLife?.housing === 'isolated', () => routine),
        branch('education-care', () => parts.includes('tentacles') && !!distressed,
            () => ({ kind: 'care', label: `${distressed!.name}を落ち着かせる`, destination: { ...distressed!.position }, priority: 100, interrupted: true })),
        branch('education-investigation', () => parts.includes('eyes') && !!defiled,
            () => ({ kind: 'investigate', label: `${defiled!.place}の異変を調べる`, destination: { ...townSite(map, defiled!.place === '住宅地' ? 'home-0' : defiled!.place === '広場' ? 'fountain' : 'hunting').entrance }, priority: 90, interrupted: true })),
        branch('education-discipline', () => parts.includes('clockwork'), () => ({ ...routine, priority: 80 })),
        branch('accepted-intervention', () => !!input && input.intent !== 'calm', () => ({ kind: input!.intent === 'investigate' ? 'investigate' : 'social', label: input!.intent === 'investigate' ? '提案を受け、広場の手掛かりを調べる' : '提案を受け、広場へ集まる', destination: { ...townSite(map, 'fountain').entrance }, priority: 75, interrupted: true })),
        branch('education-collection', () => parts.includes('teapot') && !!item, () => ({ kind: 'collect', label: '珍しい品を集める', destination: { ...item!.position }, priority: 70, interrupted: false })),
        leaf('scheduled-routine', () => routine),
    ]), world, value => value.label);
}
/** Runs after learned rules and relationship proposals, before any world side effect. */
export function finalizeResidentAction(world: World, v: Villager, proposed: ActionDecision): ActionDecision {
    const selected = selectResidentGoal(world, v);
    const goal = { ...selected, destination: { ...selected.destination } };
    const parts = educationPartsFor(v);
    const harmful = proposed.triggersIncident || proposed.relationshipEffects?.some((effect) => effect.kind === 'harass')
        || (proposed.sideEffects?.wealthDelta ?? 0) < 0;
    // The gate is a *finite* restraint keyed on how recently the lesson landed; see
    // educationHolds for why a trait comparison would silence residents permanently.
    const held = educationHolds(v, world.term);
    const gate = parts.includes('tentacles') && harmful && held ? '共感の教育が加害行動を抑制'
        : parts.includes('clockwork') && (harmful || proposed.sideEffects?.spreadInfo) && held
            ? '規律の教育が衝動・噂の拡散を抑制' : null;
    const move = { ...v.position }; // Replaced by the final collision-aware route below.
    // When the gate fires, suppress only the harmful parts of the proposal: benign
    // effects (gifts, chat, earnings) survive, so education restrains harm without
    // voiding the resident's whole turn. A plain goal interrupt replaces the action
    // outright, as before.
    const result: ActionDecision = gate || goal.interrupted ? {
        move, action: `${v.name}は${goal.label}${gate ? `。${gate}` : '（割り込み）'}`,
        newEmotion: v.emotion, triggersIncident: false, incidentSeed: null,
        ...(gate ? keepBenignEffects(proposed) : {}),
    } : { ...proposed, ...(proposed.sideEffects ? { sideEffects: { ...proposed.sideEffects } } : {}), move, action: `${goal.label}：${proposed.action}` };
    // Position is owned by the goal leaf; learned moveBias is resolved as a goal below.
    if (result.sideEffects?.moveBias) {
        const bias = result.sideEffects.moveBias;
        const target = aliveVillagers(world).find((n) => bias === 'partner' ? n.id === v.partnerId
            : bias === 'admire' ? n.id === v.admireId : n.madman && n.id !== v.id);
        // A learned visit may retarget any free slot (交流・食事). Work shifts, rest and
        // isolation keep their scheduled destination, so the routine still owns the day.
        const slot = townRoutine(world, v).activity;
        if (target && !parts.includes('clockwork') && !goal.interrupted && (slot === 'social' || slot === 'meal') && v.townLife?.housing !== 'isolated') {
            goal.destination = bias === 'awayMadman' ? clampPos(world, {
                x: v.position.x + Math.sign(v.position.x - target.position.x) * 3,
                y: v.position.y + Math.sign(v.position.y - target.position.y) * 3,
            }) : { ...target.position };
            goal.label = bias === 'awayMadman' ? '危険な住民から距離を取る' : `${target.name}を訪ねる`;
        }
        delete result.sideEffects.moveBias;
    }
    // NOTE: this advances up to 8 cells per tick (the whole sliced route), whereas the
    // pre-existing convention (TermMachine.stepToward) moved exactly one. Residents can
    // therefore pass each other without ever landing within NEARBY_RADIUS (3), which is
    // what gates incident triggering — worth confirming the pacing is intended.
    const route = townRoute(townMap(world.config), v.position, goal.destination).slice(0, 8);
    result.move = route.at(-1) ?? { ...v.position };
    const arrived = distance(result.move, goal.destination) === 0;
    if (!result.triggersIncident && !goal.interrupted && !gate) {
        const routineText = `${v.name}は${goal.label}`;
        result.action = `${routineText}${arrived ? '' : 'ために移動中'}${proposed.action === routineText ? '' : `。${proposed.action}`}`;
    }
    v.behaviorTrace = { goal, proposedAction: proposed.action, outputAction: result.action, gate, route };
    return decideWithTree(v, 'output', leaf<World, ActionDecision>('output/harness-and-navigation', () => result, () => !arrived), world, value => value.action);
}
/**
 * The subset of a suppressed proposal that is safe to keep: friendly relationship
 * effects and non-negative wealth. Harassment, losses and rumor spread are dropped,
 * which is exactly what the education gate exists to prevent.
 */
function keepBenignEffects(proposed: ActionDecision): Partial<ActionDecision> {
    const kept: Partial<ActionDecision> = {};
    const friendly = proposed.relationshipEffects?.filter((effect) => effect.kind !== 'harass');
    if (friendly?.length) kept.relationshipEffects = friendly.map((effect) => ({ ...effect, targetIds: [...effect.targetIds] }));
    const wealthDelta = proposed.sideEffects?.wealthDelta;
    if (wealthDelta !== undefined && wealthDelta > 0) kept.sideEffects = { wealthDelta };
    return kept;
}
function distance(a: GridPos, b: GridPos): number { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }
