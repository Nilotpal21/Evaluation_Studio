/**
 * Suspension Timeout Worker
 *
 * Periodically scans for expired suspensions and:
 * 1. Marks them as expired
 * 2. Removes their callback from Redis
 * 3. If part of a fan-out, marks the branch as timed out in the barrier
 *
 * Runs as a setInterval on each pod. Distributed-safe because
 * SuspensionStore.expire() is atomic (only one pod can transition the status).
 */

import { createLogger } from '@abl/compiler/platform';
import type {
  SuspensionStore,
  CallbackRegistry,
  FanOutBarrierStore,
} from '@agent-platform/execution';
import type { ResumeDispatcher } from '../execution/resumption-service.js';

const log = createLogger('suspension-timeout');

const CHECK_INTERVAL_MS = 60_000; // Check every 60 seconds
const BATCH_SIZE = 100;

export interface SuspensionTimeoutWorkerDeps {
  suspensionStore: SuspensionStore;
  callbackRegistry: CallbackRegistry;
  barrierStore: FanOutBarrierStore;
  resumeDispatcher: ResumeDispatcher;
}

export function startSuspensionTimeoutWorker(deps: SuspensionTimeoutWorkerDeps): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      const expired = await deps.suspensionStore.findExpired(BATCH_SIZE);

      for (const suspension of expired) {
        try {
          if (suspension.continuation.type === 'remote_handoff_result') {
            await deps.callbackRegistry.remove(suspension.callbackId);
            await deps.resumeDispatcher.enqueueResume(suspension.suspensionId, {
              type: 'remote_handoff_result',
              callbackId: suspension.callbackId,
              tenantId: suspension.tenantId,
              payload: {
                status: 'timeout',
                response: `Remote handoff timed out after ${Date.now() - suspension.suspendedAt.getTime()}ms`,
              },
              receivedAt: Date.now(),
            });

            log.info('Queued timed-out remote handoff for resume processing', {
              suspensionId: suspension.suspensionId,
              sessionId: suspension.sessionId,
            });
            continue;
          }

          // Mark as expired (atomic — only one pod succeeds)
          await deps.suspensionStore.expire(suspension.suspensionId);

          // Clean up callback registration
          await deps.callbackRegistry.remove(suspension.callbackId);

          // If part of a fan-out, mark the branch as timed out in the barrier
          if (suspension.barrierId) {
            const continuation = suspension.continuation;
            if (
              continuation.type === 'fan_out_branch' ||
              continuation.type === 'fan_out_remote_branch'
            ) {
              const outcome = await deps.barrierStore.completeBranch(suspension.barrierId, {
                branchId: 'branchId' in continuation ? continuation.branchId : undefined,
                branchAgent: continuation.branchAgent,
                status: 'timeout',
                error: `Suspension timed out after ${Date.now() - suspension.suspendedAt.getTime()}ms`,
                completedAt: Date.now(),
              });

              if (outcome.parentResumeReady) {
                const parentSuspensionId = await deps.barrierStore.getParentSuspension(
                  suspension.barrierId,
                );
                if (parentSuspensionId) {
                  await deps.resumeDispatcher.enqueueResume(parentSuspensionId, {
                    type: 'fan_out_parent_resume',
                    callbackId: suspension.barrierId,
                    tenantId: suspension.tenantId,
                    payload: {},
                    receivedAt: Date.now(),
                  });
                } else {
                  log.error('No parent suspension found for timed-out fan-out barrier', {
                    barrierId: suspension.barrierId,
                    suspensionId: suspension.suspensionId,
                  });
                }
              }
            }
          }

          log.info('Expired suspension', {
            suspensionId: suspension.suspensionId,
            sessionId: suspension.sessionId,
            reason: suspension.reason.type,
          });
        } catch (err) {
          log.error('Failed to expire suspension', {
            suspensionId: suspension.suspensionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.error('Suspension timeout check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, CHECK_INTERVAL_MS);

  timer.unref?.(); // Don't prevent process exit
  log.info('Suspension timeout worker started');
  return timer;
}

export function stopSuspensionTimeoutWorker(timer: NodeJS.Timeout): void {
  clearInterval(timer);
  log.info('Suspension timeout worker stopped');
}
