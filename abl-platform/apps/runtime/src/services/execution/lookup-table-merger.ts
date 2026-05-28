import { createLogger } from '@abl/compiler/platform';
import type { LookupTableIR, ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';

const log = createLogger('lookup-table-merger');

export class LookupTableConflictError extends Error {
  constructor(public tableName: string) {
    super(
      `Lookup table name conflict: "${tableName}" is defined in both ` +
        `agent DSL and project runtime config. Rename one to resolve.`,
    );
    this.name = 'LookupTableConflictError';
  }
}

/**
 * Merge agent-level lookup tables (Record from DSL) with project-level
 * lookup tables (array from ProjectRuntimeConfigIR).
 *
 * Agent tables take priority in the merged record. If a project table
 * has the same name as an agent table, a LookupTableConflictError is thrown
 * to surface the ambiguity at deploy/load time rather than at runtime.
 */
export function mergeLookupTables(
  agentTables: Record<string, LookupTableIR> | undefined,
  projectConfig: ProjectRuntimeConfigIR | undefined,
): Record<string, LookupTableIR> {
  const merged: Record<string, LookupTableIR> = {};

  if (agentTables) {
    for (const [name, table] of Object.entries(agentTables)) {
      merged[name] = table;
    }
  }

  if (projectConfig?.lookup_tables) {
    for (const table of projectConfig.lookup_tables) {
      if (merged[table.name]) {
        throw new LookupTableConflictError(table.name);
      }
      merged[table.name] = table;
    }
  }

  if (Object.keys(merged).length > 0) {
    log.debug('Merged lookup tables', { count: Object.keys(merged).length });
  }

  return merged;
}
