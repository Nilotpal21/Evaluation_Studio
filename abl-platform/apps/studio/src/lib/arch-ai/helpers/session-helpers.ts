import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  InvalidTransitionError,
  SessionNotFoundError,
  SessionArchivedError,
} from '@agent-platform/arch-ai';
import type { SessionService } from '@agent-platform/arch-ai';

const log = createLogger('api:arch-ai:message');

export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  // Check error type first — DOMException with AbortError/TimeoutError name
  if (err instanceof DOMException) {
    return err.name === 'AbortError' || err.name === 'TimeoutError';
  }

  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return true;
  }

  // Only treat as abort if signal is aborted AND the error message is causally related.
  // Avoids misclassifying real infrastructure errors (e.g. MongoDB "server selection timeout")
  // that happen to occur after the signal fires.
  if (signal?.aborted && err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('the operation was aborted') ||
      msg.includes('this operation was aborted') ||
      msg.includes('the request was aborted')
    );
  }

  return false;
}

export function isTimeoutAbort(signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }

  const { reason } = signal;
  return reason instanceof DOMException && reason.name === 'TimeoutError';
}

export function createAbortSignal(
  requestSignal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; abort: (reason: unknown) => void; cleanup: () => void } {
  const controller = new AbortController();

  const abortWithReason = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const handleRequestAbort = () => {
    abortWithReason(
      requestSignal.reason ?? new DOMException('The request was aborted.', 'AbortError'),
    );
  };

  const timeoutId = setTimeout(() => {
    abortWithReason(new DOMException('Arch AI request timed out.', 'TimeoutError'));
  }, timeoutMs);

  if (requestSignal.aborted) {
    handleRequestAbort();
  } else {
    requestSignal.addEventListener('abort', handleRequestAbort, { once: true });
  }

  return {
    signal: controller.signal,
    abort: abortWithReason,
    cleanup: () => {
      clearTimeout(timeoutId);
      requestSignal.removeEventListener('abort', handleRequestAbort);
    },
  };
}

export async function transitionSessionToIdle(
  sessionService: InstanceType<typeof SessionService>,
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    const currentSession = await sessionService.getById(ctx, sessionId);
    if (!currentSession || currentSession.state !== 'ACTIVE') {
      return;
    }

    await sessionService.transitionState(ctx, sessionId, 'ACTIVE', 'IDLE');
  } catch (err: unknown) {
    if (
      err instanceof InvalidTransitionError ||
      err instanceof SessionNotFoundError ||
      err instanceof SessionArchivedError
    ) {
      log.debug('Skipped Arch AI idle transition', { sessionId, reason });
      return;
    }

    log.warn('Non-fatal Arch AI idle transition failure', {
      error: err instanceof Error ? err.message : String(err),
      reason,
      sessionId,
    });
  }
}

export async function closeAndResetIfActive(
  sessionService: InstanceType<typeof SessionService>,
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  sessionId: string,
  close: () => void,
  reason: string,
): Promise<void> {
  await transitionSessionToIdle(sessionService, ctx, sessionId, reason);
  close();
}
