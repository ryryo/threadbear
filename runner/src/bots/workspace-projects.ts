import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readTree, type PackEntry } from '../move-pack.ts';
import type { Projects } from '../projects.ts';

export const workspaceProjectId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const workspaceProjectChoice = z.union([
  z.literal('detach'),
  z.object({ assign: z.record(workspaceProjectId, workspaceProjectId.nullable()) }).refine(({ assign }) => {
    const destinations = Object.values(assign).flatMap(id => id ? [id.toLowerCase()] : []);
    return Object.keys(assign).length <= 512 && new Set(destinations).size === destinations.length;
  }, 'Choose a separate destination for each Project scope.'),
]);
export type WorkspaceProjectChoice = z.infer<typeof workspaceProjectChoice>;

const scopePrefix = 'project-';
const isProjectScope = (name: string) => name.toLowerCase().startsWith(scopePrefix);
function memoryNames(root: string) {
  const memory = join(root, 'memory');
  if (!lstatSync(memory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(memory, { withFileTypes: true });
}

export function workspaceMemoryProjects(root: string): string[] {
  return memoryNames(root).filter(entry => entry.isDirectory() && isProjectScope(entry.name))
    .map(entry => entry.name.slice(scopePrefix.length));
}

export function assignedProjects(ids: readonly string[], choice: WorkspaceProjectChoice): string[] {
  if (choice === 'detach') return [];
  return [...new Set(ids)].flatMap(id => {
    if (!Object.hasOwn(choice.assign, id)) throw new Error(`Choose what happens to Project ${id} before moving.`);
    const target = choice.assign[id];
    return target ? [target] : [];
  });
}

export function workspaceProjectFiles(root: string, choice: WorkspaceProjectChoice): PackEntry[] {
  const entries = readTree(root, 'bots', ['memory']);
  const memory = join(root, 'memory');
  const names = memoryNames(root);
  if (!names.length) return entries;
  entries.push(...readTree(memory, 'bots/memory', names.filter(entry => isProjectScope(entry.name)).map(entry => entry.name)));
  for (const scope of names) {
    if (!scope.isDirectory() || !isProjectScope(scope.name)) continue;
    const [target] = assignedProjects([scope.name.slice(scopePrefix.length)], choice);
    if (target) entries.push(...readTree(join(memory, scope.name), 'bots/memory/' + scopePrefix + target));
  }
  return entries;
}

export function allowedWorkspaceProjectFile(path: string, destinations: ReadonlySet<string>): boolean {
  if (!path.toLowerCase().startsWith('bots/memory/')) return true;
  const scope = path.slice('bots/memory/'.length).split('/')[0];
  return !isProjectScope(scope) || destinations.has(scope.slice(scopePrefix.length));
}

export function verifyTargetProjects(projects: Projects | undefined, ids: readonly string[]): void {
  for (const id of ids) {
    const project = projects?.record(id);
    if (!project || project.archived) throw new Error(`The destination Runner does not have an active Project with ID ${id}.`);
  }
}
