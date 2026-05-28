/**
 * useStaleToolCheck Hook
 *
 * Compares the latest active agent version's tool snapshot against current
 * project tools. Returns a list of stale tools (where the sourceHash has
 * changed, runtime metadata changed) and deleted tools (no longer in the project).
 *
 * Uses sourceHash + runtime metadata comparison — no version numbers involved.
 */

import useSWR, { mutate as mutateSWR } from 'swr';
import { fetchVersions } from '../api/versions';
import { fetchTools } from '../api/tools';
import type { VersionRecord, ToolSnapshotEntry } from '../api/versions';

/** Information about a tool that has been updated since the snapshot */
export interface StaleToolInfo {
  name: string;
  projectToolId: string;
  snapshotHash: string;
  currentHash: string;
  snapshotRuntimeMetadataHash?: string;
  currentRuntimeMetadataHash?: string;
  toolType: string;
}

/** Information about a tool that was deleted from project_tools */
export interface DeletedToolInfo {
  name: string;
  projectToolId: string;
}

/** Information about a tool that was added to project_tools */
export interface NewToolInfo {
  name: string;
  projectToolId: string;
}

/**
 * Detects tool changes between agent version snapshot and current project tools.
 *
 * Returns three categories of changes:
 * - **stale**: Tool exists in both, but sourceHash differs (tool was updated)
 * - **deleted**: Tool exists in snapshot but not in current project_tools
 * - **new**: Tool exists in current project_tools but not in snapshot
 *
 * Tools without a sourceHash are ignored (considered drafts).
 *
 * @param snapshot - Tool snapshot from agent version (baseline for comparison)
 * @param currentTools - Current project_tools state from database
 * @returns Object with stale, deleted, and new tool arrays
 *
 * @example
 * const result = detectStaleTools(versionSnapshot, projectTools);
 * if (result.stale.length > 0) {
 *   console.log('Tools changed:', result.stale.map(t => t.name));
 * }
 */
export function detectStaleTools(
  snapshot: ToolSnapshotEntry[],
  currentTools: Array<{
    id: string;
    name: string;
    sourceHash?: string;
    runtimeMetadataHash?: string;
  }>,
): { stale: StaleToolInfo[]; deleted: DeletedToolInfo[]; new: NewToolInfo[] } {
  const stale: StaleToolInfo[] = [];
  const deleted: DeletedToolInfo[] = [];
  const newTools: NewToolInfo[] = [];

  const currentByName = new Map(currentTools.map((t) => [t.name, t]));
  const snapshotByName = new Map(snapshot.map((t) => [t.name, t]));

  // Detect stale and deleted tools
  for (const entry of snapshot) {
    const current = currentByName.get(entry.name);

    if (!current) {
      deleted.push({
        name: entry.name,
        projectToolId: entry.projectToolId,
      });
      continue;
    }

    const sourceHashChanged = Boolean(
      current.sourceHash && current.sourceHash !== entry.sourceHash,
    );
    const runtimeMetadataChanged = Boolean(
      entry.runtimeMetadataHash &&
      current.runtimeMetadataHash &&
      current.runtimeMetadataHash !== entry.runtimeMetadataHash,
    );

    if (sourceHashChanged || runtimeMetadataChanged) {
      stale.push({
        name: entry.name,
        projectToolId: entry.projectToolId,
        snapshotHash: entry.sourceHash,
        currentHash: current.sourceHash ?? entry.sourceHash,
        ...(entry.runtimeMetadataHash
          ? { snapshotRuntimeMetadataHash: entry.runtimeMetadataHash }
          : {}),
        ...(current.runtimeMetadataHash
          ? { currentRuntimeMetadataHash: current.runtimeMetadataHash }
          : {}),
        toolType: entry.toolType,
      });
    }
  }

  // Detect new tools (in current but not in snapshot)
  for (const current of currentTools) {
    const inSnapshot = snapshotByName.get(current.name);
    if (!inSnapshot && current.sourceHash) {
      newTools.push({
        name: current.name,
        projectToolId: current.id,
      });
    }
  }

  return { stale, deleted, new: newTools };
}

/**
 * Compares project tools against the latest active agent version's tool snapshot
 * to detect stale, deleted, and new tools.
 *
 * **Comparison logic:**
 * - Compares against **active** version's snapshot (fallback: latest version with snapshot)
 * - Uses sourceHash-based comparison (no version numbers)
 * - Identifies three change types: stale (updated), deleted, new
 *
 * **Caching:**
 * - SWR with 5-minute refresh interval, 1-minute deduplication
 * - No revalidation on focus (prevents unnecessary fetches)
 *
 * **Requirements:** R9.6-R9.8 (stale detection), C9.6 (active version priority)
 *
 * @param projectId - Project identifier (null disables hook)
 * @param agentName - Agent name (null disables hook)
 * @returns Stale/deleted/new tool lists, loading state, and error
 *
 * @example
 * const { staleTools, deletedTools, newTools, isLoading } = useStaleToolCheck(projectId, agentName);
 * if (staleTools.length > 0) {
 *   showBanner('Tools have changed. Recompile to pick up updates.');
 * }
 */
export function getStaleToolCheckKey(projectId: string | null, agentName: string | null) {
  return projectId && agentName ? (['stale-tool-check', projectId, agentName] as const) : null;
}

export async function revalidateStaleToolCheck(
  projectId: string | null,
  agentName: string | null,
): Promise<void> {
  const key = getStaleToolCheckKey(projectId, agentName);
  if (key) {
    await mutateSWR(key);
  }
}

export function useStaleToolCheck(projectId: string | null, agentName: string | null) {
  const key = getStaleToolCheckKey(projectId, agentName);

  const { data, error, isLoading } = useSWR(
    key,
    async () => {
      // Fetch latest versions and current project tools in parallel
      const [versionsRes, toolsRes] = await Promise.all([
        fetchVersions(projectId!, agentName!, { limit: 10 }),
        fetchTools(projectId!, { limit: 200 }),
      ]);

      // Find the latest active (or most recent) version with a tool snapshot
      const activeVersion = versionsRes.versions.find(
        (v: VersionRecord) => v.status === 'active' && v.toolSnapshot?.length,
      );
      const latestWithSnapshot =
        activeVersion ?? versionsRes.versions.find((v: VersionRecord) => v.toolSnapshot?.length);

      if (!latestWithSnapshot?.toolSnapshot) {
        return {
          stale: [] as StaleToolInfo[],
          deleted: [] as DeletedToolInfo[],
          new: [] as NewToolInfo[],
        };
      }

      return detectStaleTools(latestWithSnapshot.toolSnapshot, toolsRes.data);
    },
    {
      revalidateOnFocus: false,
      refreshInterval: 5 * 60 * 1000,
      dedupingInterval: 60 * 1000,
    },
  );

  return {
    staleTools: data?.stale ?? [],
    deletedTools: data?.deleted ?? [],
    newTools: data?.new ?? [],
    isLoading,
    error: error ? String(error) : null,
  };
}
