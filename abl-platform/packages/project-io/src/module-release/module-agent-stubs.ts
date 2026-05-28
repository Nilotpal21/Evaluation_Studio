/**
 * Module Agent Stubs
 *
 * Creates minimal AgentBasedDocument stubs for imported module agents.
 * Used by all compilation contexts so cross-agent validation recognizes
 * module handoff/delegate targets.
 *
 * Single source of truth -- called from Studio and Runtime compilation contexts.
 */

import { parseAgentBasedABL, type AgentBasedDocument } from '@abl/core';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('module-agent-stubs');

export const MODULE_NAME_SEPARATOR = '__';

export interface ModuleDependencyRecord {
  alias: string;
  contractSnapshot?: {
    providedAgents?: Array<{ name: string }>;
  } | null;
}

/**
 * Check whether a name uses the mounted module naming convention (alias__agent).
 */
export function isMountedModuleName(name: string): boolean {
  return name.includes(MODULE_NAME_SEPARATOR);
}

/**
 * Build minimal agent stub documents from module dependency records.
 * Each stub is a parseable `AGENT: alias__name` document that satisfies
 * cross-agent validation without carrying real logic.
 *
 * @param dependencies - Module dependency records (from ProjectModuleDependency.find().lean())
 * @param existingNames - Set or iterable of agent names already in the compilation (to avoid duplicates)
 * @returns Array of parsed AgentBasedDocument stubs (bounded by number of agents across all dependencies)
 */
export function buildModuleAgentStubs(
  dependencies: ModuleDependencyRecord[],
  existingNames?: Iterable<string>,
): AgentBasedDocument[] {
  const stubs: AgentBasedDocument[] = [];
  // Call-scoped dedup set — bounded by dependency count, cleared on return (no TTL needed)
  const seen = existingNames ? new Set(existingNames) : new Set<string>(); // .clear() on return

  for (const dep of dependencies) {
    const contract = dep.contractSnapshot;
    if (!contract?.providedAgents) continue;
    const alias = String(dep.alias ?? '');
    if (!alias) continue;

    for (const agent of contract.providedAgents) {
      if (typeof agent.name !== 'string' || agent.name.length === 0) {
        continue;
      }

      const mountedName = `${alias}${MODULE_NAME_SEPARATOR}${agent.name}`;
      if (seen.has(mountedName)) continue;

      const result = parseAgentBasedABL(
        `AGENT: ${mountedName}\nGOAL:\n  Imported module agent stub`,
      );
      if (result.document) {
        stubs.push(result.document);
        seen.add(mountedName);
      } else {
        log.warn('Failed to create module agent stub document', {
          mountedName,
          errors: result.errors,
        });
      }
    }
  }

  seen.clear();
  return stubs;
}

/**
 * Load module dependencies and build agent stubs.
 * Convenience function that queries the database and returns stubs.
 *
 * @param projectId - Consumer project ID
 * @param tenantId - Tenant ID
 * @param existingNames - Agent names already in compilation
 * @returns Array of parsed AgentBasedDocument stubs (empty on error; bounded by DB result set)
 */
export async function loadAndBuildModuleAgentStubs(
  projectId: string,
  tenantId: string,
  existingNames?: Iterable<string>,
): Promise<AgentBasedDocument[]> {
  try {
    const { ProjectModuleDependency } = await import('@agent-platform/database/models');
    const deps = await ProjectModuleDependency.find({ projectId, tenantId }).lean();
    return buildModuleAgentStubs(deps as ModuleDependencyRecord[], existingNames);
  } catch (err) {
    log.warn('Failed to load module agent stubs', {
      projectId,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
