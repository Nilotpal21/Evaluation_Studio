/**
 * Lifecycle Manager
 *
 * Centralizes the disconnect cleanup logic duplicated across handler.ts,
 * sdk-handler.ts, and twilio-media-handler.ts:
 *
 * 1. Resolve shared lifecycle policy → disposition + disconnectBehavior
 * 2. Save runtime session snapshot → end or detach based on config
 * 3. Flush message queue for the DB session
 * 4. End the DB session with the configured disposition
 */

import { createLogger } from '@abl/compiler/platform';
import type { CallDisposition } from '@abl/compiler/platform/core/types';
import { getRuntimeExecutor } from '../../services/runtime-executor.js';
import { getStores } from '../../services/stores/store-factory.js';
import { isDatabaseAvailable } from '../../db/index.js';
import { flushMessageQueue } from '../../services/message-persistence-queue.js';
import { SessionRuntimePolicyService } from '../../services/session-lifecycle/runtime-policy-service.js';
import { cleanupClosedSessionArtifacts } from '../../services/session-lifecycle/artifact-cleanup.js';
import {
  isSessionTerminalizationEnabled,
  SessionTerminalizationService,
} from '../../services/session-lifecycle/terminalization-service.js';
import type { DisconnectContext } from './types.js';

const log = createLogger('lifecycle-manager');
const runtimePolicyService = new SessionRuntimePolicyService();
const terminalizationService = new SessionTerminalizationService();

/**
 * Handle disconnect cleanup for a realtime channel session.
 *
 * Performs: runtime session snapshot + end/detach → flush message queue →
 * end DB session.
 *
 * All steps are best-effort: failures are logged but never rethrown.
 */
export async function handleDisconnect(ctx: DisconnectContext): Promise<void> {
  const executor = getRuntimeExecutor();
  const runtimeSession = ctx.sessionId ? executor.getSession(ctx.sessionId) : undefined;

  let disposition: string = 'abandoned';
  let disconnectBehavior: string = 'detach';
  const resolvedLifecycle = await runtimePolicyService.resolveDisconnectPolicy({
    channel: ctx.channel,
    tenantId: ctx.tenantId ?? runtimeSession?.tenantId,
    projectId: ctx.projectId ?? runtimeSession?.projectId,
    agentName: ctx.agentName ?? runtimeSession?.agentName,
    agentLifecycle: ctx.agentLifecycle ?? runtimeSession?.agentIR?.execution?.sessionLifecycle,
  });
  disposition = resolvedLifecycle.disposition ?? disposition;
  disconnectBehavior = resolvedLifecycle.disconnectBehavior ?? disconnectBehavior;

  if (
    disconnectBehavior === 'end' &&
    isSessionTerminalizationEnabled() &&
    ctx.tenantId &&
    ctx.projectId &&
    (ctx.dbSessionId || ctx.sessionId)
  ) {
    if (ctx.sessionId && runtimeSession) {
      try {
        await executor.saveSessionSnapshot(runtimeSession);
      } catch (err) {
        log.warn('Failed to save session snapshot', {
          sessionId: ctx.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (ctx.dbSessionId) {
      try {
        await flushMessageQueue(ctx.dbSessionId);
      } catch (err) {
        log.warn('Failed to flush message queue', {
          dbSessionId: ctx.dbSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const terminalSessionId = ctx.dbSessionId ?? ctx.sessionId;
    if (!terminalSessionId) {
      return;
    }

    const result = await terminalizationService.terminateConversationSession({
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      sessionId: terminalSessionId,
      agentName: ctx.agentName ?? runtimeSession?.agentName,
      channel: ctx.channel,
      disposition: disposition as CallDisposition,
      source: 'disconnect',
    });

    if (result) {
      await cleanupClosedSessionArtifacts(result.artifactSessionIds);

      return;
    }
  }

  // Step 1: Save runtime session snapshot + end/detach
  if (ctx.sessionId) {
    try {
      if (runtimeSession) {
        await executor.saveSessionSnapshot(runtimeSession);
      }
    } catch (err) {
      log.warn('Failed to save session snapshot', {
        sessionId: ctx.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      if (disconnectBehavior === 'end') {
        executor.endSession(ctx.sessionId);
      } else {
        executor.detachSession(ctx.sessionId);
      }
    } catch (err) {
      log.warn('Failed to end/detach runtime session', {
        sessionId: ctx.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 2: Flush message queue for this DB session
  if (ctx.dbSessionId) {
    try {
      await flushMessageQueue(ctx.dbSessionId);
    } catch (err) {
      log.warn('Failed to flush message queue', {
        dbSessionId: ctx.dbSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 3: End DB session with disposition
    if (isDatabaseAvailable()) {
      try {
        await getStores().conversation.endSession(ctx.dbSessionId, disposition as CallDisposition);
      } catch (err) {
        log.warn('Failed to end DB session', {
          dbSessionId: ctx.dbSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
