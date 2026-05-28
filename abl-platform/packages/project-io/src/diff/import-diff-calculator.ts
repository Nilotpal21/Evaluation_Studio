/**
 * Import Diff Calculator
 *
 * Computes per-agent diffs between existing project state and imported files
 * using the section-aware ABL differ.
 */

import type { ABLDiffResult } from '../types.js';
import { diffABL } from './abl-differ.js';

export interface AgentDiffEntry {
  name: string;
  status: 'added' | 'modified' | 'removed' | 'unchanged';
  diff: ABLDiffResult | null;
}

/**
 * Calculate diffs between existing agents and incoming imported agents.
 *
 * @param existingAgents - Map of agent name → current dslContent
 * @param importedAgents - Map of agent name → imported dslContent
 * @returns Per-agent diff entries
 */
export function calculateImportDiffs(
  existingAgents: Map<string, string>,
  importedAgents: Map<string, string>,
): AgentDiffEntry[] {
  const results: AgentDiffEntry[] = [];
  const allNames = new Set([...existingAgents.keys(), ...importedAgents.keys()]);

  for (const name of allNames) {
    const existing = existingAgents.get(name);
    const imported = importedAgents.get(name);

    if (existing === undefined && imported !== undefined) {
      results.push({
        name,
        status: 'added',
        diff: diffABL('', imported),
      });
    } else if (existing !== undefined && imported === undefined) {
      results.push({
        name,
        status: 'removed',
        diff: diffABL(existing, ''),
      });
    } else if (existing !== undefined && imported !== undefined) {
      if (existing === imported) {
        results.push({
          name,
          status: 'unchanged',
          diff: null,
        });
      } else {
        results.push({
          name,
          status: 'modified',
          diff: diffABL(existing, imported),
        });
      }
    }
  }

  return results;
}
