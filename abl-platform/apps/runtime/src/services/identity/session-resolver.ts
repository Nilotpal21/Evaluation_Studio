/**
 * Session Resolver
 *
 * Resolves whether an incoming connection should resume an existing session
 * or create a new one, based on:
 *   1. Explicit sessionId (client reconnect)
 *   2. Channel artifact lookup (same user, new connection)
 *   3. New session (no match found)
 *
 * Resolution keys are stored in the SessionStore (Redis/memory) with a
 * configurable TTL (default: 24 hours).
 */

import type { SessionStore } from '../session/session-store.js';
import type { CallerContext } from '@agent-platform/shared-auth';
import type { SessionResolutionStrategy } from '@agent-platform/shared-kernel/types';
import { DEFAULT_RESUME_WINDOW_SECONDS } from './artifact-hasher.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('session-resolver');

// =============================================================================
// TYPES
// =============================================================================

export type SessionResolutionOutcome = 'existing' | 'new';

export interface SessionResolutionResult {
  outcome: SessionResolutionOutcome;
  sessionId?: string;
  reason: string;
}

export interface ResolveSessionInput {
  tenantId: string;
  channelId?: string;
  explicitSessionId?: string;
  callerContext: CallerContext;
  resolutionStrategy?: SessionResolutionStrategy;
}

// =============================================================================
// RESOLVER
// =============================================================================

/**
 * Resolve whether to resume an existing session or create a new one.
 *
 * Resolution paths (in priority order):
 *   1. explicitSessionId → load from store → resume if found
 *   2. channel artifact → resolution key lookup → verify session exists → resume
 *   3. always_new strategy or no match → new session
 */
export async function resolveSession(
  store: SessionStore,
  input: ResolveSessionInput,
): Promise<SessionResolutionResult> {
  const { tenantId, channelId, explicitSessionId, callerContext, resolutionStrategy } = input;

  // Strategy: always_new — skip all lookups
  if (resolutionStrategy === 'always_new') {
    log.debug('Session resolution: always_new strategy', { tenantId });
    return { outcome: 'new', reason: 'always_new strategy' };
  }

  // Path 1: Explicit session ID (client reconnect)
  if (explicitSessionId) {
    const session = await store.load(explicitSessionId);
    if (session) {
      // Tenant isolation: verify the session belongs to the requesting tenant
      if (session.tenantId && session.tenantId !== tenantId) {
        log.warn('Session tenant mismatch — refusing cross-tenant resume', {
          requestTenantId: tenantId,
          sessionTenantId: session.tenantId,
          sessionId: explicitSessionId,
        });
        return { outcome: 'new', reason: 'tenant_mismatch' };
      }
      log.info('Session resolved via explicit ID', { tenantId, sessionId: explicitSessionId });
      return {
        outcome: 'existing',
        sessionId: explicitSessionId,
        reason: 'explicit_session_id',
      };
    }
    log.debug('Explicit sessionId not found, falling through', { tenantId, explicitSessionId });
    // Session expired or not found — fall through to artifact lookup
  }

  // Path 2: Channel artifact resolution
  if (channelId && callerContext.channelArtifact) {
    const existingSessionId = await store.getResolutionKey(
      tenantId,
      channelId,
      callerContext.channelArtifact,
    );

    if (existingSessionId) {
      // Verify the session still exists (resolution key may outlive the session)
      const session = await store.load(existingSessionId);
      if (session) {
        // Tenant isolation: verify the session belongs to the requesting tenant
        if (session.tenantId && session.tenantId !== tenantId) {
          log.warn('Artifact-resolved session tenant mismatch — cleaning stale key', {
            requestTenantId: tenantId,
            sessionTenantId: session.tenantId,
            sessionId: existingSessionId,
          });
          await store.deleteResolutionKey(tenantId, channelId, callerContext.channelArtifact);
          // Fall through to new session
        } else {
          log.info('Session resolved via channel artifact', {
            tenantId,
            channelId,
            sessionId: existingSessionId,
          });
          return {
            outcome: 'existing',
            sessionId: existingSessionId,
            reason: 'channel_artifact',
          };
        }
      }

      // Stale resolution key — clean it up
      log.warn('Stale resolution key cleaned up', {
        tenantId,
        channelId,
        sessionId: existingSessionId,
      });
      await store.deleteResolutionKey(tenantId, channelId, callerContext.channelArtifact);
    }
  }

  // Path 3: No match — new session
  log.debug('No existing session found, creating new', { tenantId, channelId });
  return { outcome: 'new', reason: 'no_match' };
}

/**
 * Register a resolution key mapping a channel artifact to a session ID.
 * Called after session creation so future connections with the same artifact
 * can resume the session.
 */
export async function registerResolutionKey(
  store: SessionStore,
  input: {
    tenantId: string;
    channelId: string;
    artifactHash: string;
    sessionId: string;
    resumeWindowSeconds?: number;
  },
): Promise<void> {
  const ttl = input.resumeWindowSeconds ?? DEFAULT_RESUME_WINDOW_SECONDS;
  await store.setResolutionKey(
    input.tenantId,
    input.channelId,
    input.artifactHash,
    input.sessionId,
    ttl,
  );
  log.info('Resolution key registered', {
    tenantId: input.tenantId,
    channelId: input.channelId,
    sessionId: input.sessionId,
    ttlSeconds: ttl,
  });
}
