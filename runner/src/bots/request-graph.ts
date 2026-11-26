export type DispatchScope = { sourceBotId?: string; targetBotId: string; parentRequestId?: string };
export type RequestNode = DispatchScope & { id: string; rootRequestId: string };
const REQUEST_DEPTH = 4;
export const ROOT_CHILDREN = 32;

/** Validates the new edge against persisted requests of the owning workspace. */
export function parentScope(input: DispatchScope, rows: ReadonlyMap<string, RequestNode>, newId: string, checkBudget = true): { rootRequestId: string; depth: number } {
  const visited = new Set<string>();
  const ancestors = new Set([input.targetBotId]);
  if (input.sourceBotId) {
    if (ancestors.has(input.sourceBotId)) throw new Error('A Bot cannot delegate to itself');
    ancestors.add(input.sourceBotId);
  }
  let id = input.parentRequestId;
  let reached = input.sourceBotId;
  let rootRequestId = newId;
  let depth = 1;
  while (id !== undefined) {
    if (visited.has(id)) throw new Error('The Bot request history contains a cycle');
    visited.add(id);
    const parent = rows.get(id);
    if (!parent || parent.targetBotId !== reached) throw new Error('This request cannot delegate for another Bot');
    if (parent.sourceBotId) {
      if (ancestors.has(parent.sourceBotId)) throw new Error('The delegation would return to an ancestor Bot');
      ancestors.add(parent.sourceBotId);
    }
    reached = parent.sourceBotId;
    rootRequestId = parent.rootRequestId;
    id = parent.parentRequestId;
    depth++;
    if (depth > REQUEST_DEPTH) throw new Error('This Bot request reached its delegation depth limit');
  }
  if (checkBudget && input.parentRequestId !== undefined && [...rows.values()].filter(row => row.rootRequestId === rootRequestId && row.id !== rootRequestId).length >= ROOT_CHILDREN) {
    throw new Error('This Bot request reached its child limit');
  }
  return { rootRequestId, depth };
}
