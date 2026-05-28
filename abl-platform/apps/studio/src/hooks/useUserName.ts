import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import { apiFetch, handleResponse } from '../lib/api-client';

/**
 * Resolve a userId to a display name.
 *
 * Checks the current auth user first (no network call),
 * then falls back to a batch user lookup API.
 */
export function useUserName(userId: string | undefined): string | undefined {
  const currentUser = useAuthStore((s) => s.user);

  // Fast path: if it's the current user, return immediately
  const isCurrentUser = userId && currentUser && userId === currentUser.id;
  const shouldFetch = !!userId && !isCurrentUser;

  const { data } = useSWR(
    shouldFetch ? `/api/users/batch?ids=${encodeURIComponent(userId)}` : null,
    async (url: string) => {
      const res = await apiFetch(url);
      const json = await handleResponse<{ users: Record<string, { name: string; email: string }> }>(
        res,
      );
      return json.users;
    },
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  if (!userId) return undefined;
  if (isCurrentUser) return currentUser.name || currentUser.email || userId;
  const resolved = data?.[userId];
  if (resolved) return resolved.name || resolved.email || userId;
  return undefined;
}
