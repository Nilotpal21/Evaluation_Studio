/**
 * Conflict Resolver — three-way comparison for git sync conflicts
 *
 * Compares base (last sync), ours (local), and theirs (remote) to detect
 * conflicts. Does NOT auto-merge — presents both versions for user resolution.
 */

import type { ConflictDetail, ConflictResolution, ConflictStrategy } from '../types.js';

export interface ThreeWayInput {
  file: string;
  agentName: string;
  base: string | null;
  ours: string;
  theirs: string;
}

export type ConflictCheckResult =
  | { conflict: false; resolution: 'accept_theirs' | 'keep_ours' | 'identical'; content: string }
  | { conflict: true; detail: ConflictDetail };

/**
 * Perform three-way conflict check on a single file.
 *
 * Logic:
 * - base === ours → no local changes, safe to accept theirs
 * - base === theirs → no remote changes, safe to keep ours
 * - ours === theirs → identical changes, no conflict
 * - all differ → CONFLICT
 */
export function checkConflict(input: ThreeWayInput): ConflictCheckResult {
  const { base, ours, theirs, file, agentName } = input;

  // Both are the same — no conflict regardless of base
  if (ours === theirs) {
    return { conflict: false, resolution: 'identical', content: ours };
  }

  // No local changes since last sync — accept remote
  if (base !== null && base === ours) {
    return { conflict: false, resolution: 'accept_theirs', content: theirs };
  }

  // No remote changes since last sync — keep local
  if (base !== null && base === theirs) {
    return { conflict: false, resolution: 'keep_ours', content: ours };
  }

  // Both differ from base (or no base) — conflict
  return {
    conflict: true,
    detail: {
      agentName,
      file,
      baseContent: base,
      localContent: ours,
      remoteContent: theirs,
    },
  };
}

/**
 * Check conflicts for a batch of files.
 *
 * @param inputs - Three-way inputs for each file
 * @returns Separate lists of resolved and conflicting files
 */
export function checkConflicts(inputs: ThreeWayInput[]): {
  resolved: Array<{ file: string; agentName: string; content: string; resolution: string }>;
  conflicts: ConflictDetail[];
} {
  const resolved: Array<{ file: string; agentName: string; content: string; resolution: string }> =
    [];
  const conflicts: ConflictDetail[] = [];

  for (const input of inputs) {
    const result = checkConflict(input);
    if (result.conflict) {
      conflicts.push(result.detail);
    } else {
      resolved.push({
        file: input.file,
        agentName: input.agentName,
        content: result.content,
        resolution: result.resolution,
      });
    }
  }

  return { resolved, conflicts };
}

/**
 * Apply a conflict resolution strategy to auto-resolve where possible.
 */
export function autoResolveConflicts(
  conflicts: ConflictDetail[],
  strategy: ConflictStrategy,
): ConflictResolution[] {
  if (strategy === 'manual') return [];

  return conflicts.map((c) => ({
    file: c.file,
    resolution: strategy === 'local_wins' ? ('local' as const) : ('remote' as const),
    mergedContent: strategy === 'local_wins' ? c.localContent : c.remoteContent,
  }));
}
