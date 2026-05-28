import { createLogger } from '@abl/compiler/platform';

const log = createLogger('session-artifact-cleanup');

export async function cleanupClosedSessionArtifacts(sessionIds: Iterable<string>): Promise<void> {
  const dedupedSessionIds = Array.from(
    new Set(
      Array.from(sessionIds).filter(
        (sessionId): sessionId is string =>
          typeof sessionId === 'string' && sessionId.trim().length > 0,
      ),
    ),
  );

  if (dedupedSessionIds.length === 0) {
    return;
  }

  try {
    const { getPausedExecutionStore } = await import('../auth-profile/paused-execution-store.js');
    const pausedExecutionStore = getPausedExecutionStore();
    await Promise.allSettled(
      dedupedSessionIds.map((sessionId) =>
        pausedExecutionStore.cleanupSession(sessionId, 'disconnect'),
      ),
    );
  } catch (error) {
    log.warn('Session artifact cleanup failed', {
      sessionIds: dedupedSessionIds,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
