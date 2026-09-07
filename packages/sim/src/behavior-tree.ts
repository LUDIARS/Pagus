/** Synchronous reactive BT. Running leaves are reconsidered from the root next tick. */
export type BtStatus = 'success' | 'failure' | 'running';
export interface BtVisit { node: string; status: BtStatus }
export interface BtResult<T> { status: BtStatus; value?: T }
export interface BtNode<C, T> { id: string; tick(context: C, trace: BtVisit[]): BtResult<T> }

export function leaf<C, T>(id: string, action: (context: C) => T, running: (context: C) => boolean = () => false): BtNode<C, T> {
  return { id, tick(context, trace) { const value = action(context); const status = running(context) ? 'running' : 'success'; trace.push({ node: id, status }); return { status, value }; } };
}
export function condition<C, T>(id: string, predicate: (context: C) => boolean): BtNode<C, T> {
  return { id, tick(context, trace) { const status = predicate(context) ? 'success' : 'failure'; trace.push({ node: id, status }); return { status }; } };
}
export function sequence<C, T>(id: string, children: BtNode<C, T>[]): BtNode<C, T> {
  return { id, tick(context, trace) {
    let result: BtResult<T> = { status: 'success' };
    for (const child of children) { result = child.tick(context, trace); if (result.status !== 'success') break; }
    trace.push({ node: id, status: result.status }); return result;
  } };
}
export function selector<C, T>(id: string, children: BtNode<C, T>[]): BtNode<C, T> {
  return { id, tick(context, trace) {
    for (const child of children) { const result = child.tick(context, trace); if (result.status !== 'failure') { trace.push({ node: id, status: result.status }); return result; } }
    trace.push({ node: id, status: 'failure' }); return { status: 'failure' };
  } };
}
export function branch<C, T>(id: string, when: (context: C) => boolean, action: (context: C) => T): BtNode<C, T> {
  return sequence(id, [condition(`${id}/condition`, when), leaf(`${id}/action`, action)]);
}
export function runTree<C, T>(root: BtNode<C, T>, context: C): { value: T; visits: BtVisit[] } {
  const visits: BtVisit[] = [];
  const result = root.tick(context, visits);
  if (result.status === 'failure' || result.value === undefined) throw new Error(`Behavior tree ${root.id} produced no action`);
  return { value: result.value, visits };
}
