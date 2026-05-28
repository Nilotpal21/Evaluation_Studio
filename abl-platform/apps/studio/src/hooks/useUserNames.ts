import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import { apiFetch, handleResponse } from '../lib/api-client';

/**
 * Batch-resolve an array of userIds to display names.
 *
 * Returns a stable map: `{ [userId]: displayName }`.
 * Checks the current auth user first (no network call for that ID),
 * then falls back to the batch user lookup API for remaining IDs.
 */
export function useUserNames(userIds: string[]): Record<string, string> {
  const currentUser = useAuthStore((s) => s.user);

  // Filter out current user and empty/duplicate IDs
  const idsToFetch = Array.from(
    new Set(userIds.filter((id) => id && (!currentUser || id !== currentUser.id))),
  );

  const fetchKey =
    idsToFetch.length > 0
      ? `/api/users/batch?ids=${idsToFetch.map(encodeURIComponent).join(',')}`
      : null;

  const { data } = useSWR(
    fetchKey,
    async (url: string) => {
      const res = await apiFetch(url);
      const json = await handleResponse<{
        users: Record<string, { name: string; email: string }>;
      }>(res);
      return json.users;
    },
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  // Build resolved map
  const resolved: Record<string, string> = {};
  for (const id of userIds) {
    if (!id) continue;
    if (currentUser && id === currentUser.id) {
      resolved[id] = currentUser.name || currentUser.email || id;
    } else if (data?.[id]) {
      resolved[id] = data[id].name || data[id].email || id;
    }
  }
  return resolved;
}
