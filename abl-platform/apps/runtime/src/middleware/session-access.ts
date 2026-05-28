import type { Request } from 'express';
import {
  evaluateSessionOwnershipAccess,
  getRequestAccessDeniedReporter,
} from '@agent-platform/shared-auth';
import { findStoredSessionByAnyId } from '../repos/session-repo.js';
import { evaluateProjectPermission } from './rbac.js';
import { buildStoredSessionAccessSource } from '../services/identity/stored-session-access-source.js';
import { buildStoredSessionCallerContext } from '../services/identity/stored-session-caller-context.js';

export interface ProjectSessionAccessOptions {
  sessionId: string;
  projectId: string;
  requiredPermission: string;
  resourceType?: string;
}

export interface ProjectSessionAccessDenied {
  denial: {
    statusCode: number;
    publicError: string;
    publicMessage?: string;
  };
}

export interface ProjectSessionAccessGranted<TSession = any> {
  session: TSession;
}

export type ProjectSessionAccessResult<TSession = any> =
  | ProjectSessionAccessGranted<TSession>
  | ProjectSessionAccessDenied;

export async function resolveProjectSessionAccess(
  req: Request<any>,
  options: ProjectSessionAccessOptions,
): Promise<ProjectSessionAccessResult> {
  const projectAccess = await evaluateProjectPermission(
    req,
    options.requiredPermission,
    options.projectId,
    { concealNotMember: true },
  );
  if (!projectAccess.allowed) {
    if (projectAccess.statusCode !== 400) {
      getRequestAccessDeniedReporter(req)({
        layer: 'runtime_rbac',
        scope: projectAccess.scope,
        reasonCode: projectAccess.reasonCode,
        reason: projectAccess.reason,
        concealAsNotFound: projectAccess.concealAsNotFound,
        statusCode: projectAccess.statusCode as 401 | 403 | 404,
        projectId: projectAccess.projectId ?? options.projectId,
        resourceType: options.resourceType ?? 'session',
        resourceId: options.sessionId,
        requiredPermission: options.requiredPermission,
      });
    }
    return {
      denial: {
        statusCode: projectAccess.statusCode,
        publicError: projectAccess.publicError,
        publicMessage: projectAccess.publicMessage,
      },
    };
  }

  const tenantContext = req.tenantContext;
  if (!tenantContext?.tenantId) {
    getRequestAccessDeniedReporter(req)({
      layer: 'require_tenant_context',
      scope: 'tenant',
      reasonCode: 'TENANT_CONTEXT_REQUIRED',
      reason: 'Tenant context is required for this operation',
      concealAsNotFound: false,
      statusCode: 403,
      projectId: options.projectId,
      resourceType: options.resourceType ?? 'session',
      resourceId: options.sessionId,
      requiredPermission: options.requiredPermission,
    });
    return {
      denial: {
        statusCode: 403,
        publicError: 'Tenant context is required for this operation',
      },
    };
  }

  const session = await findStoredSessionByAnyId(options.sessionId, tenantContext.tenantId);
  if (!session) {
    getRequestAccessDeniedReporter(req)({
      layer: 'session_ownership',
      scope: 'user',
      reasonCode: 'SESSION_NOT_FOUND',
      reason: 'Session not found',
      concealAsNotFound: true,
      statusCode: 404,
      projectId: options.projectId,
      resourceType: options.resourceType ?? 'session',
      resourceId: options.sessionId,
      requiredPermission: options.requiredPermission,
    });
    return {
      denial: {
        statusCode: 404,
        publicError: 'Session not found',
      },
    };
  }

  if (session.projectId !== options.projectId) {
    getRequestAccessDeniedReporter(req)({
      layer: 'session_ownership',
      scope: 'project',
      reasonCode: 'SESSION_PROJECT_MISMATCH',
      reason: 'Session does not belong to the requested project',
      concealAsNotFound: true,
      statusCode: 404,
      projectId: options.projectId,
      resourceType: options.resourceType ?? 'session',
      resourceId: options.sessionId,
      requiredPermission: options.requiredPermission,
      metadata: {
        sessionProjectId: session.projectId,
      },
    });
    return {
      denial: {
        statusCode: 404,
        publicError: 'Session not found',
      },
    };
  }

  const ownership = evaluateSessionOwnershipAccess(tenantContext, {
    callerContext: buildStoredSessionCallerContext(session, tenantContext.tenantId),
    ownerUserId: typeof session.initiatedById === 'string' ? session.initiatedById : undefined,
    source: buildStoredSessionAccessSource(session),
  });
  if (!ownership.allowed) {
    getRequestAccessDeniedReporter(req)({
      layer: 'session_ownership',
      scope: ownership.scope ?? 'user',
      reasonCode: ownership.reasonCode ?? 'SESSION_ACCESS_DENIED',
      reason: ownership.reason ?? 'Session not found',
      concealAsNotFound: ownership.concealAsNotFound,
      statusCode: ownership.statusCode ?? 404,
      projectId: options.projectId,
      resourceType: options.resourceType ?? 'session',
      resourceId: options.sessionId,
      requiredPermission: options.requiredPermission,
    });
    return {
      denial: {
        statusCode: ownership.statusCode ?? 404,
        publicError: ownership.statusCode === 401 ? 'Authentication required' : 'Session not found',
      },
    };
  }

  return { session };
}
