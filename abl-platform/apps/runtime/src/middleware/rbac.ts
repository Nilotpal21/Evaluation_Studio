/**
 * RBAC Middleware
 *
 * Shared role-based access control helpers for route handlers.
 * Uses the authenticated tenant context for tenant-level role checks and
 * project-level membership checks for project-scoped resources.
 */

import type { Request, Response } from 'express';
import { findProjectByIdAndTenant, findProjectMember } from '../repos/project-repo.js';
import { getRequestAccessDeniedReporter } from '@agent-platform/shared-auth';
import {
  evaluateProjectPermission as evaluateSharedProjectPermission,
  hasExactPermission,
  hasPermission,
  type SensitiveExactPermission,
} from '@agent-platform/shared/rbac';
import { isTenantAdminRole } from '@agent-platform/shared-auth/rbac';
import { resolveProjectCustomRolePermissions } from '../services/permission-resolution.js';

export const WRITE_ROLES = ['OWNER', 'ADMIN', 'OPERATOR'] as const;
export const READ_ROLES = ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'] as const;

interface RuntimeAccessDeniedResult {
  allowed: false;
  statusCode: 400 | 401 | 403 | 404;
  publicError: string;
  publicMessage?: string;
  reasonCode: string;
  reason: string;
  concealAsNotFound: boolean;
  scope: 'auth' | 'project' | 'rbac';
  projectId?: string;
  resourceType?: string;
  resourceId?: string;
}

interface RuntimeAccessAllowedResult {
  allowed: true;
  accessLevel:
    | 'api_key'
    | 'sdk_session'
    | 'tenant_admin'
    | 'project_owner'
    | 'project_admin'
    | 'project_member';
  projectId?: string;
}

type RuntimeAccessResult = RuntimeAccessAllowedResult | RuntimeAccessDeniedResult;

interface ProjectPermissionOptions {
  concealNotMember?: boolean;
}

function getGrantedPermissions(ctx: { permissions?: unknown }): readonly string[] {
  return Array.isArray(ctx.permissions)
    ? ctx.permissions.filter((permission): permission is string => typeof permission === 'string')
    : [];
}

function sendRuntimeAccessDenied(
  req: Request<any>,
  res: Response,
  result: RuntimeAccessDeniedResult,
  requiredPermission?: string | string[],
): false {
  if (result.statusCode !== 400) {
    getRequestAccessDeniedReporter(req)({
      layer: 'runtime_rbac',
      scope: result.scope,
      reasonCode: result.reasonCode,
      reason: result.reason,
      concealAsNotFound: result.concealAsNotFound,
      statusCode: result.statusCode as 401 | 403 | 404,
      projectId: result.projectId,
      resourceType: result.resourceType,
      resourceId: result.resourceId,
      requiredPermission,
    });
  }

  const body: Record<string, unknown> = {
    success: false,
    error: {
      code: result.reasonCode,
      message: result.publicError,
    },
  };
  if (result.publicMessage) {
    body.message = result.publicMessage;
  }
  if (requiredPermission) {
    body.required = requiredPermission;
  }

  res.status(result.statusCode).json(body);
  return false;
}

/**
 * Check that the authenticated user has a write role in the current tenant.
 * Sends 401/403 and returns false if the check fails; returns true on success.
 *
 * @deprecated Use `requirePermissionInline` for granular permission checks.
 *
 * Usage in route handlers:
 *   if (!(await requireWriteAccess(req, res))) return;
 */
export async function requireWriteAccess(req: Request<any>, res: Response): Promise<boolean> {
  if (!req.tenantContext) {
    return sendRuntimeAccessDenied(
      req,
      res,
      {
        allowed: false,
        statusCode: 401,
        publicError: 'Authentication required',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        reason: 'Authentication required',
        concealAsNotFound: false,
        scope: 'auth',
      },
      'tenant:write',
    );
  }
  if (!req.tenantContext.userId) {
    return sendRuntimeAccessDenied(
      req,
      res,
      {
        allowed: false,
        statusCode: 401,
        publicError: 'User identity required',
        reasonCode: 'USER_ID_MISSING',
        reason: 'Tenant context lacks userId',
        concealAsNotFound: false,
        scope: 'auth',
      },
      'tenant:write',
    );
  }
  if (!WRITE_ROLES.includes(req.tenantContext.role as (typeof WRITE_ROLES)[number])) {
    return sendRuntimeAccessDenied(
      req,
      res,
      {
        allowed: false,
        statusCode: 403,
        publicError: 'Insufficient permissions',
        reasonCode: 'TENANT_WRITE_ROLE_REQUIRED',
        reason: 'Tenant write-capable role required',
        concealAsNotFound: false,
        scope: 'rbac',
        resourceType: req.tenantContext?.tenantId ? 'tenant' : undefined,
        resourceId: req.tenantContext?.tenantId,
      },
      'tenant:write',
    );
  }
  return true;
}

/**
 * Check that the authenticated user has a specific granular permission.
 * Sends 401/403 and returns false if the check fails; returns true on success.
 *
 * Usage in openapi.route handlers where middleware can't be used:
 *   if (!requirePermissionInline(req, res, 'agent:update')) return;
 */
export function requirePermissionInline(
  req: Request<any>,
  res: Response,
  permission: string,
): boolean {
  const ctx = (req as any).tenantContext;
  if (!ctx) {
    return sendRuntimeAccessDenied(
      req,
      res,
      {
        allowed: false,
        statusCode: 401,
        publicError: 'Authentication required',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        reason: 'Authentication required',
        concealAsNotFound: false,
        scope: 'auth',
      },
      permission,
    );
  }
  if (!hasPermission(ctx.permissions || [], permission)) {
    return sendRuntimeAccessDenied(
      req,
      res,
      {
        allowed: false,
        statusCode: 403,
        publicError: 'Forbidden',
        reasonCode: 'PERMISSION_REQUIRED',
        reason: `Missing required permission '${permission}'`,
        concealAsNotFound: false,
        scope: 'rbac',
      },
      permission,
    );
  }
  return true;
}

export async function evaluateProjectPermission(
  req: Request<any>,
  permission: string,
  explicitProjectId?: string,
  options: ProjectPermissionOptions = {},
): Promise<RuntimeAccessResult> {
  const ctx = (req as any).tenantContext;
  if (!ctx) {
    return {
      allowed: false,
      statusCode: 401,
      publicError: 'Authentication required',
      reasonCode: 'AUTHENTICATION_REQUIRED',
      reason: 'Authentication required',
      concealAsNotFound: false,
      scope: 'auth',
    };
  }

  const projectId = explicitProjectId || req.params.projectId;

  if (ctx.authType === 'sdk_session') {
    if (!ctx.projectId) {
      return {
        allowed: false,
        statusCode: 403,
        publicError: 'SDK session missing project scope',
        reasonCode: 'SDK_PROJECT_SCOPE_REQUIRED',
        reason: 'SDK session missing project scope',
        concealAsNotFound: false,
        scope: 'project',
        projectId,
        resourceType: 'project',
        resourceId: projectId,
      };
    }

    if (projectId && ctx.projectId !== projectId) {
      return {
        allowed: false,
        statusCode: 404,
        publicError: 'Project not found',
        reasonCode: 'SDK_PROJECT_SCOPE_MISMATCH',
        reason: 'SDK token project scope does not match the requested project',
        concealAsNotFound: true,
        scope: 'project',
        projectId,
        resourceType: 'project',
        resourceId: projectId,
      };
    }

    if (!hasPermission(ctx.permissions || [], permission)) {
      return {
        allowed: false,
        statusCode: 403,
        publicError: 'Forbidden',
        reasonCode: 'PERMISSION_REQUIRED',
        reason: `Missing required permission '${permission}'`,
        concealAsNotFound: false,
        scope: 'rbac',
        projectId: projectId ?? ctx.projectId,
      };
    }

    return {
      allowed: true,
      accessLevel: 'sdk_session',
      projectId: projectId ?? ctx.projectId,
    };
  }

  if (!projectId) {
    return {
      allowed: false,
      statusCode: 400,
      publicError: 'Project ID required',
      reasonCode: 'PROJECT_ID_REQUIRED',
      reason: 'Project ID required',
      concealAsNotFound: false,
      scope: 'project',
    };
  }

  if (Array.isArray(ctx.projectScope) && ctx.projectScope.length > 0) {
    if (!ctx.projectScope.includes(projectId)) {
      return {
        allowed: false,
        statusCode: 404,
        publicError: 'Project not found',
        reasonCode: 'PROJECT_SCOPE_MISMATCH',
        reason: 'Caller does not have access to this project',
        concealAsNotFound: true,
        scope: 'project',
        projectId,
        resourceType: 'project',
        resourceId: projectId,
      };
    }
  }

  const project = await findProjectByIdAndTenant(projectId, ctx.tenantId);
  if (!project) {
    return {
      allowed: false,
      statusCode: 404,
      publicError: 'Project not found',
      reasonCode: 'PROJECT_NOT_FOUND',
      reason: 'Project not found',
      concealAsNotFound: true,
      scope: 'project',
      projectId,
      resourceType: 'project',
      resourceId: projectId,
    };
  }

  if (ctx.authType === 'api_key') {
    const permissions = ctx.permissions || [];
    if (!hasPermission(permissions, permission) && !hasPermission(permissions, 'project:*')) {
      return {
        allowed: false,
        statusCode: 403,
        publicError: 'Forbidden',
        reasonCode: 'PERMISSION_REQUIRED',
        reason: `Missing required permission '${permission}'`,
        concealAsNotFound: false,
        scope: 'rbac',
        projectId,
        resourceType: 'project',
        resourceId: projectId,
      };
    }

    return {
      allowed: true,
      accessLevel: 'api_key',
      projectId,
    };
  }

  const userId = ctx.userId;
  if (!userId) {
    return {
      allowed: false,
      statusCode: 401,
      publicError: 'User identity required',
      reasonCode: 'USER_ID_REQUIRED',
      reason: 'User identity required',
      concealAsNotFound: false,
      scope: 'auth',
      projectId,
    };
  }

  // Tenant-admin bypass — accepts either signal so we stay aligned with
  // Studio's `isTenantAdmin` (apps/studio/src/lib/project-access.ts), which
  // also passes on role OR `project:*` permission. A drift between these two
  // checks 404s every project route for tenant admins whose JWT lacks the
  // expanded permissions claim. Note: this bypass is *not* applied in the
  // sensitive-permission variant below, which intentionally requires an
  // exact grant (see hasSensitivePermission).
  if (isTenantAdminRole(ctx.role) || hasPermission(ctx.permissions || [], 'project:*')) {
    return {
      allowed: true,
      accessLevel: 'tenant_admin',
      projectId,
    };
  }

  if ((project as any).ownerId === userId) {
    return {
      allowed: true,
      accessLevel: 'project_owner',
      projectId,
    };
  }

  const member = await findProjectMember(projectId, userId);
  if (!member) {
    const concealNotMember = options.concealNotMember ?? true;
    return {
      allowed: false,
      statusCode: concealNotMember ? 404 : 403,
      publicError: concealNotMember ? 'Project not found' : 'Forbidden',
      publicMessage: concealNotMember ? undefined : 'You are not a member of this project',
      reasonCode: 'PROJECT_MEMBERSHIP_REQUIRED',
      reason: 'You are not a member of this project',
      concealAsNotFound: concealNotMember,
      scope: 'project',
      projectId,
      resourceType: 'project',
      resourceId: projectId,
    };
  }

  const role = (member as any).role as string;
  const normalizedRole = role.trim().toLowerCase();
  const customRolePermissions =
    normalizedRole === 'custom'
      ? await resolveProjectCustomRolePermissions(
          ctx.tenantId,
          typeof (member as any).customRoleId === 'string' ? (member as any).customRoleId : null,
        )
      : [];

  if (!evaluateSharedProjectPermission(normalizedRole, permission, customRolePermissions)) {
    return {
      allowed: false,
      statusCode: 403,
      publicError: 'Forbidden',
      publicMessage: `Project ${role} role does not have '${permission}' permission`,
      reasonCode: 'PROJECT_PERMISSION_REQUIRED',
      reason: `Project ${role} role does not have '${permission}' permission`,
      concealAsNotFound: false,
      scope: 'rbac',
      projectId,
      resourceType: 'project',
      resourceId: projectId,
    };
  }

  return {
    allowed: true,
    accessLevel: normalizedRole === 'admin' ? 'project_admin' : 'project_member',
    projectId,
  };
}

async function evaluateSensitiveProjectPermission(
  req: Request<any>,
  permission: SensitiveExactPermission,
  explicitProjectId?: string,
): Promise<RuntimeAccessResult> {
  const ctx = (req as any).tenantContext;
  if (!ctx) {
    return {
      allowed: false,
      statusCode: 401,
      publicError: 'Authentication required',
      reasonCode: 'AUTHENTICATION_REQUIRED',
      reason: 'Authentication required',
      concealAsNotFound: false,
      scope: 'auth',
    };
  }

  const projectId = explicitProjectId || req.params.projectId;

  if (ctx.authType === 'sdk_session') {
    if (!ctx.projectId) {
      return {
        allowed: false,
        statusCode: 403,
        publicError: 'SDK session missing project scope',
        reasonCode: 'SDK_PROJECT_SCOPE_REQUIRED',
        reason: 'SDK session missing project scope',
        concealAsNotFound: false,
        scope: 'project',
        projectId,
        resourceType: 'project',
        resourceId: projectId,
      };
    }

    if (projectId && ctx.projectId !== projectId) {
      return {
        allowed: false,
        statusCode: 404,
        publicError: 'Project not found',
        reasonCode: 'SDK_PROJECT_SCOPE_MISMATCH',
        reason: 'SDK token project scope does not match the requested project',
        concealAsNotFound: true,
        scope: 'project',
        projectId,
        resourceType: 'project',
        resourceId: projectId,
      };
    }

    const effectiveProjectId = projectId ?? ctx.projectId;
    const project = await findProjectByIdAndTenant(effectiveProjectId, ctx.tenantId);
    if (!project) {
      return {
        allowed: false,
        statusCode: 404,
        publicError: 'Project not found',
        reasonCode: 'PROJECT_NOT_FOUND',
        reason: 'Project not found',
        concealAsNotFound: true,
        scope: 'project',
        projectId: effectiveProjectId,
        resourceType: 'project',
        resourceId: effectiveProjectId,
      };
    }

    if (!hasExactPermission(getGrantedPermissions(ctx), permission)) {
      return {
        allowed: false,
        statusCode: 403,
        publicError: 'Forbidden',
        reasonCode: 'SENSITIVE_PERMISSION_REQUIRED',
        reason: `Missing exact sensitive permission '${permission}'`,
        concealAsNotFound: false,
        scope: 'rbac',
        projectId: effectiveProjectId,
        resourceType: 'project',
        resourceId: effectiveProjectId,
      };
    }

    return {
      allowed: true,
      accessLevel: 'sdk_session',
      projectId: effectiveProjectId,
    };
  }

  if (!projectId) {
    return {
      allowed: false,
      statusCode: 400,
      publicError: 'Project ID required',
      reasonCode: 'PROJECT_ID_REQUIRED',
      reason: 'Project ID required',
      concealAsNotFound: false,
      scope: 'project',
    };
  }

  if (
    ctx.authType === 'api_key' &&
    (!Array.isArray(ctx.projectScope) || ctx.projectScope.length === 0)
  ) {
    return {
      allowed: false,
      statusCode: 403,
      publicError: 'API key missing project scope',
      reasonCode: 'API_KEY_PROJECT_SCOPE_REQUIRED',
      reason: 'API key missing project scope',
      concealAsNotFound: false,
      scope: 'project',
      projectId,
      resourceType: 'project',
      resourceId: projectId,
    };
  }

  if (Array.isArray(ctx.projectScope) && ctx.projectScope.length > 0) {
    if (!ctx.projectScope.includes(projectId)) {
      return {
        allowed: false,
        statusCode: 404,
        publicError: 'Project not found',
        reasonCode: 'PROJECT_SCOPE_MISMATCH',
        reason: 'Caller does not have access to this project',
        concealAsNotFound: true,
        scope: 'project',
        projectId,
        resourceType: 'project',
        resourceId: projectId,
      };
    }
  }

  const project = await findProjectByIdAndTenant(projectId, ctx.tenantId);
  if (!project) {
    return {
      allowed: false,
      statusCode: 404,
      publicError: 'Project not found',
      reasonCode: 'PROJECT_NOT_FOUND',
      reason: 'Project not found',
      concealAsNotFound: true,
      scope: 'project',
      projectId,
      resourceType: 'project',
      resourceId: projectId,
    };
  }

  const directExactGrant = hasExactPermission(getGrantedPermissions(ctx), permission);

  if (ctx.authType === 'api_key') {
    if (!directExactGrant) {
      return {
        allowed: false,
        statusCode: 403,
        publicError: 'Forbidden',
        reasonCode: 'SENSITIVE_PERMISSION_REQUIRED',
        reason: `Missing exact sensitive permission '${permission}'`,
        concealAsNotFound: false,
        scope: 'rbac',
        projectId,
        resourceType: 'project',
        resourceId: projectId,
      };
    }

    return {
      allowed: true,
      accessLevel: 'api_key',
      projectId,
    };
  }

  const userId = ctx.userId;
  if (!userId) {
    return {
      allowed: false,
      statusCode: 401,
      publicError: 'User identity required',
      reasonCode: 'USER_ID_REQUIRED',
      reason: 'User identity required',
      concealAsNotFound: false,
      scope: 'auth',
      projectId,
    };
  }

  const hasTenantProjectAccess = hasPermission(getGrantedPermissions(ctx), 'project:*');
  if (hasTenantProjectAccess) {
    if (!directExactGrant) {
      return {
        allowed: false,
        statusCode: 403,
        publicError: 'Forbidden',
        reasonCode: 'SENSITIVE_PERMISSION_REQUIRED',
        reason: `Missing exact sensitive permission '${permission}'`,
        concealAsNotFound: false,
        scope: 'rbac',
        projectId,
        resourceType: 'project',
        resourceId: projectId,
      };
    }

    return {
      allowed: true,
      accessLevel: 'tenant_admin',
      projectId,
    };
  }

  if ((project as any).ownerId === userId && directExactGrant) {
    return {
      allowed: true,
      accessLevel: 'project_owner',
      projectId,
    };
  }

  const member = await findProjectMember(projectId, userId);
  if (!member) {
    const ownerWithoutExactGrant = (project as any).ownerId === userId;
    return {
      allowed: false,
      statusCode: ownerWithoutExactGrant ? 403 : 404,
      publicError: ownerWithoutExactGrant ? 'Forbidden' : 'Project not found',
      reasonCode: ownerWithoutExactGrant
        ? 'SENSITIVE_PERMISSION_REQUIRED'
        : 'PROJECT_MEMBERSHIP_REQUIRED',
      reason: ownerWithoutExactGrant
        ? `Missing exact sensitive permission '${permission}'`
        : 'You are not a member of this project',
      concealAsNotFound: !ownerWithoutExactGrant,
      scope: ownerWithoutExactGrant ? 'rbac' : 'project',
      projectId,
      resourceType: 'project',
      resourceId: projectId,
    };
  }

  const role = (member as any).role as string;
  const normalizedRole = role.trim().toLowerCase();
  const customRolePermissions =
    normalizedRole === 'custom'
      ? await resolveProjectCustomRolePermissions(
          ctx.tenantId,
          typeof (member as any).customRoleId === 'string' ? (member as any).customRoleId : null,
        )
      : [];

  if (
    directExactGrant ||
    (normalizedRole === 'custom' && hasExactPermission(customRolePermissions, permission))
  ) {
    return {
      allowed: true,
      accessLevel: normalizedRole === 'admin' ? 'project_admin' : 'project_member',
      projectId,
    };
  }

  return {
    allowed: false,
    statusCode: 403,
    publicError: 'Forbidden',
    publicMessage: `Project ${role} role does not have exact '${permission}' permission`,
    reasonCode: 'SENSITIVE_PERMISSION_REQUIRED',
    reason: `Project ${role} role does not have exact '${permission}' permission`,
    concealAsNotFound: false,
    scope: 'rbac',
    projectId,
    resourceType: 'project',
    resourceId: projectId,
  };
}

// =============================================================================
// PROJECT MEMBERSHIP RBAC
// =============================================================================

// PROJECT_ROLE_PERMISSIONS imported from @agent-platform/shared/rbac (centralized module).
// Re-export for backward compatibility with any external consumers.
export { PROJECT_ROLE_PERMISSIONS } from '@agent-platform/shared/rbac';

/**
 * Check that the authenticated user has a specific project-level permission.
 *
 * Resolution order:
 * 1. Project existence → 404 if project not found in tenant (enforces tenant isolation)
 * 2. API keys → permission check against scoped key permissions only (no creator owner/member bypass)
 * 3. Tenant OWNER/ADMIN → full access to all projects within that tenant
 * 4. Project owner → full access to owned project (ownerId match)
 * 5. Project member → permission check based on project role
 * 6. No membership → 404 (concealed as 'Project not found' to prevent existence leaks)
 *
 * Usage in openapi.route handlers for project-scoped resources:
 *   if (!(await requireProjectPermission(req, res, 'channel:create'))) return;
 */
export async function requireProjectPermission(
  req: Request<any>,
  res: Response,
  permission: string,
  explicitProjectId?: string,
): Promise<boolean> {
  const result = await evaluateProjectPermission(req, permission, explicitProjectId, {
    concealNotMember: true,
  });
  if (!result.allowed) {
    return sendRuntimeAccessDenied(req, res, result, permission);
  }
  return true;
}

export async function requireSensitiveProjectPermission(
  req: Request<any>,
  res: Response,
  permission: SensitiveExactPermission,
  explicitProjectId?: string,
): Promise<boolean> {
  const result = await evaluateSensitiveProjectPermission(req, permission, explicitProjectId);
  if (!result.allowed) {
    return sendRuntimeAccessDenied(req, res, result, permission);
  }
  return true;
}

/**
 * @deprecated `requireProjectPermission` now conceals non-members in the same way.
 * Prefer `requireProjectPermission`.
 */
export async function requireConcealedProjectPermission(
  req: Request<any>,
  res: Response,
  permission: string,
  explicitProjectId?: string,
): Promise<boolean> {
  const result = await evaluateProjectPermission(req, permission, explicitProjectId, {
    concealNotMember: true,
  });
  if (!result.allowed) {
    return sendRuntimeAccessDenied(req, res, result, permission);
  }
  return true;
}

/**
 * Require project-wide analytics visibility.
 *
 * Analytics routes that target a single session should use `resolveProjectSessionAccess`
 * with `session:read`. Project-wide analytics and pipeline dashboards are gated by the
 * dedicated `analytics:read` permission.
 */
export async function requireProjectWideAnalyticsAccess(
  req: Request<any>,
  res: Response,
  explicitProjectId?: string,
): Promise<boolean> {
  const result = await evaluateProjectPermission(req, 'analytics:read', explicitProjectId, {
    concealNotMember: true,
  });
  if (!result.allowed) {
    return sendRuntimeAccessDenied(req, res, result, 'analytics:read');
  }

  return true;
}

/**
 * Governance read access: passes for analytics:read OR governance:audit-read.
 * Returns true if access is granted; calls sendRuntimeAccessDenied and returns false otherwise.
 */
export async function requireGovernanceReadAccess(
  req: Request<any>,
  res: Response,
  explicitProjectId?: string,
): Promise<boolean> {
  const analyticsResult = await evaluateProjectPermission(
    req,
    'analytics:read',
    explicitProjectId,
    {
      concealNotMember: true,
    },
  );
  if (analyticsResult.allowed) return true;
  const auditResult = await evaluateProjectPermission(
    req,
    'governance:audit-read',
    explicitProjectId,
    { concealNotMember: true },
  );
  if (auditResult.allowed) return true;
  return sendRuntimeAccessDenied(req, res, analyticsResult, 'analytics:read');
}

/**
 * @deprecated Use `requireProjectWideAnalyticsAccess`.
 */
export async function requireProjectWideSessionVisibility(
  req: Request<any>,
  res: Response,
  explicitProjectId?: string,
): Promise<boolean> {
  return requireProjectWideAnalyticsAccess(req, res, explicitProjectId);
}
