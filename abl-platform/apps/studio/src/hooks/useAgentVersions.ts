/**
 * useAgentVersions Hook
 *
 * Fetches and manages versions for a specific agent.
 * Uses SWR for data fetching; keeps version store for diff UI state.
 */

import { useCallback } from 'react';
import useSWR from 'swr';
import { useVersionStore } from '../store/version-store';
import { fetchVersions, createVersion, promoteVersion } from '../api/versions';
import type { VersionListResponse } from '../api/versions';
import { toast } from 'sonner';
import { sanitizeError } from '../lib/sanitize-error';
import { revalidateStaleToolCheck } from './useStaleToolCheck';

async function revalidateVersionMutationCaches(
  mutateVersions: () => Promise<unknown>,
  projectId: string,
  agentName: string,
): Promise<void> {
  await Promise.all([mutateVersions(), revalidateStaleToolCheck(projectId, agentName)]);
}

export function useAgentVersions(projectId: string | null, agentName: string | null) {
  const { setDiffVersions, setShowDiff, diffVersionA, diffVersionB, showDiff } = useVersionStore();

  const key = projectId && agentName ? (['versions', projectId, agentName] as const) : null;

  const { data, error, isLoading, mutate } = useSWR<VersionListResponse>(
    key,
    () => fetchVersions(projectId!, agentName!, { limit: 50 }),
    { revalidateOnFocus: false },
  );

  const versions = data?.versions ?? [];
  const total = data?.total ?? 0;

  const create = useCallback(
    async (changelog?: string) => {
      if (!projectId || !agentName) return;
      try {
        const result = await createVersion(projectId, agentName, changelog);
        if (result.deduplicated) {
          toast.info('No changes to version — source is identical to latest');
        } else {
          toast.success(`Version ${result.version} created`);
          if (result.warnings?.length) {
            for (const w of result.warnings) {
              if (/^E7\d{2}:/.test(w)) {
                // Tool link resolution errors — show as error toast
                toast.error(w.replace(/^E7\d{2}:\s*/, ''));
              } else if (/^W8\d{2}:/.test(w)) {
                // Tool link warnings (e.g. implicit injection)
                toast.warning(w.replace(/^W8\d{2}:\s*/, ''));
              } else {
                toast.warning(w);
              }
            }
          }
        }
        await revalidateVersionMutationCaches(() => mutate(), projectId, agentName);
        return result;
      } catch (err) {
        toast.error(sanitizeError(err, 'Failed to create version'));
        throw err;
      }
    },
    [projectId, agentName, mutate],
  );

  const promote = useCallback(
    async (version: string, targetStatus: string) => {
      if (!projectId || !agentName) return;
      try {
        const result = await promoteVersion(projectId, agentName, version, targetStatus);
        // Optimistic update: patch the promoted version in the SWR cache
        await mutate(
          (current) => {
            if (!current) return current;
            return {
              ...current,
              versions: current.versions.map((v) =>
                v.version === version ? { ...v, status: result.version.status } : v,
              ),
            };
          },
          { revalidate: false },
        );
        toast.success(`Version ${version} promoted to ${targetStatus}`);
        return result;
      } catch (err) {
        toast.error(sanitizeError(err, 'Failed to promote version'));
        throw err;
      }
    },
    [projectId, agentName, mutate],
  );

  return {
    versions,
    total,
    isLoading,
    error: error ? String(error) : null,
    reload: () => mutate(),
    create,
    promote,
    // Diff UI state — still managed by version store
    diffVersionA,
    diffVersionB,
    showDiff,
    setDiffVersions,
    setShowDiff,
  };
}
