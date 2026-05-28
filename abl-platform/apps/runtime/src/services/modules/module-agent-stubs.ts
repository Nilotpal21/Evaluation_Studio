import { parseAgentBasedABL, type AgentBasedDocument } from '@abl/core';
import { createLogger } from '@abl/compiler/platform';
import { loadModuleDependencies } from './module-dependency-cache.js';

const log = createLogger('module-agent-stubs');

export const MODULE_NAME_SEPARATOR = '__';

interface ModuleDependencyStubSource {
  alias?: unknown;
  contractSnapshot?: {
    providedAgents?: Array<{ name?: unknown }>;
  } | null;
}

export function isMountedModuleName(name: string): boolean {
  return name.includes(MODULE_NAME_SEPARATOR);
}

export async function loadModuleAgentStubDocuments(
  projectId: string,
  tenantId: string,
  existingNames: Iterable<string> = [],
): Promise<AgentBasedDocument[]> {
  const moduleDeps = (await loadModuleDependencies(
    projectId,
    tenantId,
  )) as ModuleDependencyStubSource[];
  const seenNames = new Set(existingNames);
  const stubs: AgentBasedDocument[] = [];

  for (const dep of moduleDeps) {
    const depAlias = typeof dep.alias === 'string' ? dep.alias : '';
    if (!depAlias || !dep.contractSnapshot?.providedAgents) {
      continue;
    }

    for (const provided of dep.contractSnapshot.providedAgents) {
      if (typeof provided.name !== 'string' || provided.name.length === 0) {
        continue;
      }

      const mountedName = `${depAlias}${MODULE_NAME_SEPARATOR}${provided.name}`;
      if (seenNames.has(mountedName)) {
        continue;
      }

      const stubResult = parseAgentBasedABL(
        `AGENT: ${mountedName}\nGOAL:\n  Imported module agent stub`,
      );
      if (stubResult.document) {
        stubs.push(stubResult.document);
        seenNames.add(mountedName);
      } else {
        log.warn('Failed to create module agent stub document', {
          projectId,
          mountedName,
          errors: stubResult.errors,
        });
      }
    }
  }

  return stubs;
}
