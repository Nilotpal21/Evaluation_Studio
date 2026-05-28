import { useEffect, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';

/**
 * Fires a POST to /api/academy/streak once per page load to record
 * the user's daily activity for streak tracking.
 *
 * Uses a ref to prevent double-calls (React Strict Mode, re-mounts).
 * Fire-and-forget — does not return data or expose loading state.
 */
export function useAcademyStreak(): void {
  const calledRef = useRef(false);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    apiFetch('/api/academy/streak', { method: 'POST' }).catch((err: unknown) => {
      // Streak update is non-critical — log but do not surface to user.
      // eslint-disable-next-line no-console
      console.warn(
        '[academy-streak] Failed to update streak:',
        err instanceof Error ? err.message : String(err),
      );
    });
  }, []);
}
