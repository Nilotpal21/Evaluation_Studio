import { setNestedValue } from '@abl/compiler';
import type { AgentIR } from '@abl/compiler';

import type { RuntimeSession } from './types.js';

export interface RuntimeGrantedMemoryMeta {
  access: 'read' | 'readwrite';
  path: string;
  sourcePath: string;
  sourceScope?: 'user' | 'project' | 'execution_tree';
}

type GrantedMemoryState = {
  flat: Record<string, unknown>;
  nested: Record<string, unknown>;
  meta: Record<string, RuntimeGrantedMemoryMeta>;
};

export const EXECUTION_TREE_NAMESPACE = 'execution_tree';
export const GRANTED_MEMORY_NAMESPACE = 'granted_memory';

function normalizeExecutionTreePath(path: string): string {
  return path.startsWith(`${EXECUTION_TREE_NAMESPACE}.`)
    ? path.slice(`${EXECUTION_TREE_NAMESPACE}.`.length)
    : path;
}

export function ensureExecutionTreeValues(
  session: Pick<RuntimeSession, 'executionTreeValues'>,
): Record<string, unknown> {
  if (!session.executionTreeValues) {
    session.executionTreeValues = {};
  }

  return session.executionTreeValues;
}

export function getExecutionTreeValue(
  session: Pick<RuntimeSession, 'executionTreeValues'>,
  path: string,
): unknown {
  return ensureExecutionTreeValues(session)[normalizeExecutionTreePath(path)];
}

export function setExecutionTreeValue(
  session: Pick<RuntimeSession, 'executionTreeValues'>,
  path: string,
  value: unknown,
): string {
  const normalizedPath = normalizeExecutionTreePath(path);
  ensureExecutionTreeValues(session)[normalizedPath] = value;
  return normalizedPath;
}

export function refreshExecutionTreeProjection(
  session: Pick<RuntimeSession, 'agentIR' | 'data' | 'executionTreeValues'>,
  agentIR?: AgentIR | null,
): Record<string, unknown> {
  const effectiveAgentIR = agentIR ?? session.agentIR;
  const declaredPaths =
    effectiveAgentIR?.memory?.persistent
      ?.filter((entry) => (entry.scope as string) === 'execution_tree')
      .map((entry) => entry.path) ?? [];

  if (declaredPaths.length === 0) {
    delete session.data.values[EXECUTION_TREE_NAMESPACE];
    return {};
  }

  const projection: Record<string, unknown> = {};
  for (const path of declaredPaths) {
    const value = getExecutionTreeValue(session, path) ?? session.data.values[path];
    if (value !== undefined) {
      setNestedValue(projection, path, value);
    }
  }

  if (Object.keys(projection).length === 0) {
    delete session.data.values[EXECUTION_TREE_NAMESPACE];
    return {};
  }

  session.data.values[EXECUTION_TREE_NAMESPACE] = projection;
  return projection;
}

export function buildGrantedMemoryState(
  grants: Array<{
    path: string;
    access: 'read' | 'readwrite';
    value: unknown;
    sourcePath?: string;
    sourceScope?: 'user' | 'project' | 'execution_tree';
  }>,
): GrantedMemoryState {
  const flat: Record<string, unknown> = {};
  const nested: Record<string, unknown> = {};
  const meta: Record<string, RuntimeGrantedMemoryMeta> = {};

  for (const grant of grants) {
    meta[grant.path] = {
      access: grant.access,
      path: grant.path,
      sourcePath: grant.sourcePath ?? grant.path,
      sourceScope: grant.sourceScope,
    };

    if (grant.value === undefined) {
      continue;
    }

    flat[grant.path] = grant.value;
    setNestedValue(nested, grant.path, grant.value);
  }

  return { flat, nested, meta };
}

export function applyGrantedMemoryState(
  session: Pick<RuntimeSession, 'data'>,
  state: GrantedMemoryState,
): void {
  if (Object.keys(state.flat).length === 0 && Object.keys(state.meta).length === 0) {
    delete session.data.values._granted_memory;
    delete session.data.values._granted_memory_meta;
    delete session.data.values[GRANTED_MEMORY_NAMESPACE];
    return;
  }

  session.data.values._granted_memory_meta = state.meta;
  if (Object.keys(state.flat).length === 0) {
    delete session.data.values._granted_memory;
    delete session.data.values[GRANTED_MEMORY_NAMESPACE];
    return;
  }

  session.data.values._granted_memory = state.flat;
  session.data.values[GRANTED_MEMORY_NAMESPACE] = state.nested;
}

function getGrantedMemoryMetaMap(
  session: Pick<RuntimeSession, 'data'>,
): Record<string, RuntimeGrantedMemoryMeta> {
  const raw = session.data.values._granted_memory_meta;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return raw as Record<string, RuntimeGrantedMemoryMeta>;
}

function syncGrantedMemoryAlias(
  session: Pick<RuntimeSession, 'data'>,
  grantPath: string,
  value: unknown,
): void {
  const grantedRoot =
    session.data.values[GRANTED_MEMORY_NAMESPACE] &&
    typeof session.data.values[GRANTED_MEMORY_NAMESPACE] === 'object' &&
    !Array.isArray(session.data.values[GRANTED_MEMORY_NAMESPACE])
      ? (session.data.values[GRANTED_MEMORY_NAMESPACE] as Record<string, unknown>)
      : {};
  setNestedValue(grantedRoot, grantPath, value);
  session.data.values[GRANTED_MEMORY_NAMESPACE] = grantedRoot;

  const flatGranted =
    session.data.values._granted_memory &&
    typeof session.data.values._granted_memory === 'object' &&
    !Array.isArray(session.data.values._granted_memory)
      ? (session.data.values._granted_memory as Record<string, unknown>)
      : {};
  flatGranted[grantPath] = value;
  session.data.values._granted_memory = flatGranted;
}

function syncGrantedMemoryAliasesForSourcePath(
  session: Pick<RuntimeSession, 'data'>,
  sourcePath: string,
  value: unknown,
): void {
  for (const [grantPath, meta] of Object.entries(getGrantedMemoryMetaMap(session))) {
    if (meta.sourceScope === 'execution_tree' && meta.sourcePath === sourcePath) {
      syncGrantedMemoryAlias(session, grantPath, value);
    }
  }
}

export function getWritableGrantedMemoryKeys(session: Pick<RuntimeSession, 'data'>): string[] {
  return Object.entries(getGrantedMemoryMetaMap(session))
    .filter(([, meta]) => meta.access === 'readwrite')
    .map(([path]) => `${GRANTED_MEMORY_NAMESPACE}.${path}`);
}

export function getWritableExecutionTreePaths(session: Pick<RuntimeSession, 'agentIR'>): string[] {
  return (
    session.agentIR?.memory?.persistent
      ?.filter((entry) => (entry.scope as string) === 'execution_tree' && entry.access !== 'read')
      .map((entry) => entry.path) ?? []
  );
}

export function isExecutionTreeMemoryPath(
  session: Pick<RuntimeSession, 'agentIR'>,
  path: string,
): boolean {
  if (path.startsWith(`${EXECUTION_TREE_NAMESPACE}.`)) {
    return true;
  }

  return (
    session.agentIR?.memory?.persistent?.some(
      (entry) => (entry.scope as string) === 'execution_tree' && entry.path === path,
    ) ?? false
  );
}

export function applyScopedMemoryWrite(
  session: Pick<RuntimeSession, 'agentIR' | 'data' | 'executionTreeValues'>,
  key: string,
  value: unknown,
): boolean {
  if (key.startsWith(`${GRANTED_MEMORY_NAMESPACE}.`)) {
    syncGrantedMemoryWrite(session, key.slice(`${GRANTED_MEMORY_NAMESPACE}.`.length), value);
    return true;
  }

  if (!isExecutionTreeMemoryPath(session, key)) {
    return false;
  }

  const normalizedPath = setExecutionTreeValue(session, key, value);
  session.data.values[normalizedPath] = value;
  if (normalizedPath !== key) {
    session.data.values[key] = value;
  }
  syncGrantedMemoryAliasesForSourcePath(session, normalizedPath, value);
  refreshExecutionTreeProjection(session);
  return true;
}

export function syncGrantedMemoryWrite(
  session: Pick<RuntimeSession, 'agentIR' | 'data' | 'executionTreeValues'>,
  grantPath: string,
  value: unknown,
): boolean {
  syncGrantedMemoryAlias(session, grantPath, value);

  const metadata = getGrantedMemoryMetaMap(session);
  const grantMeta = metadata[grantPath];

  if (grantMeta?.access === 'readwrite' && grantMeta.sourceScope === 'execution_tree') {
    const syncPath = grantMeta.sourcePath || grantPath;
    setExecutionTreeValue(session, syncPath, value);
    session.data.values[syncPath] = value;
    refreshExecutionTreeProjection(session);
    return true;
  }

  return false;
}
