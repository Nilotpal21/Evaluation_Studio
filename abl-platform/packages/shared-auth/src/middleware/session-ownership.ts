/**
 * Session Ownership
 *
 * Pure functions:
 *   matchesSessionOwner(): Compares a session's caller identity to a requesting
 *   user's CallerIdentity.
 *
 *   buildSessionListFilter(): Produces a MongoDB filter for listing sessions
 *   scoped to the calling end-user's identity.
 *
 * Express middleware:
 *   createRequireSessionOwnership(): Factory that returns middleware enforcing
 *   session ownership for SDK auth and user-owned platform sessions.
 *
 * Identity-tier priority logic:
 *   Tier 2 (customerId) > Tier 1 (channelArtifact) > session principal > legacy anonymousId
 */

import type { Request, Response, NextFunction } from 'express';
import type { CallerContext, TenantContextData } from '../types/index.js';
import type { CallerIdentity, AuthContext, ChannelUserContext } from '../types/auth-context.js';
import { toAuthContext } from './auth-context-bridge.js';
import { getRequestAccessDeniedReporter } from './access-denial.js';

/**
 * Platform roles with broad project visibility. Non-admin members must only
 * access sessions they initiated.
 */
export function isElevatedPlatformRole(role: string | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/**
 * Check whether a platform member owns a session via its stored creator.
 */
export function matchesPlatformMemberSessionOwner(
  sessionOwnerUserId: string | null | undefined,
  requestUserId: string | null | undefined,
): boolean {
  return !!sessionOwnerUserId && !!requestUserId && sessionOwnerUserId === requestUserId;
}

/**
 * Check if the requesting user owns the session.
 * Matches on the strongest available identity tier:
 *   Tier 2 (customerId) > Tier 1 (channelArtifact) > session principal > legacy anonymousId
 *
 * Returns true only if both the session and the request have the same
 * identity field populated AND the values match. If neither side has any
 * identity field, returns false (no anonymous-to-anonymous passthrough).
 */
export function matchesSessionOwner(
  sessionCaller: CallerContext,
  requestIdentity: CallerIdentity,
  requestChannelId?: string,
): boolean {
  if (requestChannelId !== undefined) {
    if (!sessionCaller.channelId || sessionCaller.channelId !== requestChannelId) {
      return false;
    }
  }

  const requestSessionPrincipal = requestIdentity.sessionPrincipalId ?? requestIdentity.anonymousId;
  const sessionPrincipal = sessionCaller.sessionPrincipalId ?? sessionCaller.anonymousId;

  if (requestIdentity.authScope === 'session') {
    return (
      !!requestSessionPrincipal &&
      !!sessionPrincipal &&
      requestSessionPrincipal === sessionPrincipal
    );
  }

  // Tier 2: verified customerId (strongest)
  if (requestIdentity.customerId && sessionCaller.customerId) {
    return requestIdentity.customerId === sessionCaller.customerId;
  }

  // Tier 1: channelArtifact -- SHA-256 hashed device/cookie/phone
  if (requestIdentity.channelArtifact && sessionCaller.channelArtifact) {
    return requestIdentity.channelArtifact === sessionCaller.channelArtifact;
  }

  // Session principal: explicit anonymous/session-scoped identity
  if (requestSessionPrincipal && sessionPrincipal) {
    return requestSessionPrincipal === sessionPrincipal;
  }

  return false;
}

/**
 * Build a MongoDB filter for listing sessions scoped to the caller's identity.
 *
 * For SDK auth (sdk_session): only returns sessions that belong to this
 * end-user, filtered by the strongest available identity field.
 *
 * For other auth types (user, api_key): returns all sessions in the project.
 * Access control is handled elsewhere (RBAC permissions, project scope).
 *
 * If an SDK caller has no identity fields at all, returns an impossible filter
 * ({ _id: { $exists: false } }) so the query returns zero results rather than
 * leaking other users' sessions.
 */
export function buildSessionListFilter(
  ctx: AuthContext,
  projectId: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = { tenantId: ctx.tenantId, projectId };

  if (ctx.authType !== 'sdk_session') {
    return base;
  }

  const identity = (ctx as ChannelUserContext).callerIdentity;
  const sdkBase: Record<string, unknown> = {
    ...base,
    channelId: (ctx as ChannelUserContext).channelId,
  };
  const sessionPrincipalId = identity.sessionPrincipalId ?? identity.anonymousId;

  if (identity.authScope === 'session') {
    return sessionPrincipalId
      ? { ...sdkBase, anonymousId: sessionPrincipalId }
      : { ...sdkBase, _id: { $exists: false } };
  }

  if (identity.customerId) {
    return { ...sdkBase, customerId: identity.customerId };
  }
  if (identity.channelArtifact) {
    return { ...sdkBase, channelArtifact: identity.channelArtifact };
  }
  if (identity.sessionPrincipalId) {
    return { ...sdkBase, anonymousId: identity.sessionPrincipalId };
  }
  if (identity.anonymousId) {
    return { ...sdkBase, anonymousId: identity.anonymousId };
  }

  // No identity -- return impossible filter (no sessions match)
  return { ...sdkBase, _id: { $exists: false } };
}

// =============================================================================
// EXPRESS MIDDLEWARE
// =============================================================================

export interface SessionOwnershipConfig {
  /** Load a session by ID and tenantId. Returns session ownership metadata or null. */
  findSession(sessionId: string, tenantId: string): Promise<SessionOwnershipSubject | null>;
}

export type SessionAccessSource =
  | { type: 'studio'; workspaceUserId?: string | null }
  | { type: 'public'; endUserId?: string | null; contactId?: string | null }
  | {
      type: 'channel';
      channelId?: string | null;
      endUserId?: string | null;
      contactId?: string | null;
    };

export interface SessionOwnershipSubject {
  callerContext?: CallerContext;
  ownerUserId?: string | null;
  source?: SessionAccessSource;
}

export interface SessionOwnershipEvaluation {
  allowed: boolean;
  statusCode?: 401 | 404;
  reasonCode?: string;
  reason?: string;
  concealAsNotFound: boolean;
  scope?: 'auth' | 'user';
}

export function evaluateSessionOwnershipAccess(
  tenantCtx: TenantContextData | undefined,
  session: SessionOwnershipSubject | null,
): SessionOwnershipEvaluation {
  if (!tenantCtx) {
    return {
      allowed: false,
      statusCode: 401,
      reasonCode: 'AUTHENTICATION_REQUIRED',
      reason: 'Authentication required',
      concealAsNotFound: false,
      scope: 'auth',
    };
  }

  if (!session) {
    return {
      allowed: false,
      statusCode: 404,
      reasonCode: 'SESSION_NOT_FOUND',
      reason: 'Session not found',
      concealAsNotFound: true,
      scope: 'user',
    };
  }

  if (tenantCtx.authType === 'api_key') {
    return { allowed: true, concealAsNotFound: false };
  }

  if (tenantCtx.authType === 'user') {
    if (isElevatedPlatformRole(tenantCtx.role)) {
      return { allowed: true, concealAsNotFound: false };
    }

    if (session.source?.type === 'studio') {
      return { allowed: true, concealAsNotFound: false };
    }

    if (!matchesPlatformMemberSessionOwner(session.ownerUserId, tenantCtx.userId)) {
      return {
        allowed: false,
        statusCode: 404,
        reasonCode: 'SESSION_OWNER_MISMATCH',
        reason: 'Session not found',
        concealAsNotFound: true,
        scope: 'user',
      };
    }

    return { allowed: true, concealAsNotFound: false };
  }

  const authCtx = toAuthContext(tenantCtx) as ChannelUserContext;
  if (!session.callerContext) {
    return {
      allowed: false,
      statusCode: 404,
      reasonCode: 'SESSION_CALLER_CONTEXT_MISSING',
      reason: 'Session not found',
      concealAsNotFound: true,
      scope: 'user',
    };
  }

  if (!matchesSessionOwner(session.callerContext, authCtx.callerIdentity, authCtx.channelId)) {
    return {
      allowed: false,
      statusCode: 404,
      reasonCode: 'SESSION_OWNER_MISMATCH',
      reason: 'Session not found',
      concealAsNotFound: true,
      scope: 'user',
    };
  }

  return { allowed: true, concealAsNotFound: false };
}

/**
 * Middleware factory: enforce session ownership for SDK auth and non-admin
 * platform members.
 *
 * For SDK sessions:     loads session, checks identity match. Returns 404 on mismatch.
 * For User JWT admins:  passes through (project-level RBAC checked elsewhere).
 * For User JWT members: checks ownerUserId match. Returns 404 on mismatch.
 * For API Key:          passes through (project scope checked elsewhere).
 */
export function createRequireSessionOwnership(
  config: SessionOwnershipConfig,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantCtx = req.tenantContext as TenantContextData | undefined;
    if (!tenantCtx) {
      getRequestAccessDeniedReporter(req)({
        layer: 'session_ownership',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        reason: 'Authentication required',
        concealAsNotFound: false,
        statusCode: 401,
      });
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const sessionId = req.params.sessionId || req.params.id;
    if (!sessionId) {
      // No session referenced (e.g., list endpoint) -- pass through
      next();
      return;
    }

    if (tenantCtx.authType === 'api_key') {
      // API keys are project-scoped integrations, not end-user identities.
      next();
      return;
    }

    if (tenantCtx.authType === 'user' && isElevatedPlatformRole(tenantCtx.role)) {
      // Elevated platform roles already passed project-scoped authorization.
      // They may still need access to active runtime-only sessions that do not
      // have persisted session ownership metadata yet.
      next();
      return;
    }

    const session = await config.findSession(sessionId, tenantCtx.tenantId);
    const access = evaluateSessionOwnershipAccess(tenantCtx, session);
    if (!access.allowed) {
      getRequestAccessDeniedReporter(req)({
        layer: 'session_ownership',
        scope: access.scope ?? 'user',
        reasonCode: access.reasonCode ?? 'SESSION_ACCESS_DENIED',
        reason: access.reason ?? 'Session not found',
        concealAsNotFound: access.concealAsNotFound,
        statusCode: access.statusCode ?? 404,
        resourceType: 'session',
        resourceId: sessionId,
      });
      if (access.statusCode === 401) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    next();
  };
}
