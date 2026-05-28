import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRole, requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';

export type ArchAuditScope =
  | {
      mode: 'workspace';
      tenantId: string;
      userId: string;
      projectId?: undefined;
    }
  | {
      mode: 'project';
      tenantId: string;
      userId: string;
      projectId: string;
    };

export async function requireArchAuditScope(
  request: NextRequest,
  projectId?: string,
): Promise<ArchAuditScope | NextResponse> {
  const auth = await requireTenantAuth(request);
  if (isAuthError(auth)) {
    return auth;
  }

  if (projectId) {
    const access = await requireProjectAccess(projectId, auth);
    if (isAccessError(access)) {
      return access;
    }

    return {
      mode: 'project',
      tenantId: auth.tenantId,
      userId: auth.id,
      projectId,
    };
  }

  const adminCheck = await requireAdminRole(auth.id, auth.tenantId);
  if (adminCheck) {
    return adminCheck;
  }

  return {
    mode: 'workspace',
    tenantId: auth.tenantId,
    userId: auth.id,
  };
}

export function isArchAuditScopeError(scope: ArchAuditScope | NextResponse): scope is NextResponse {
  return scope instanceof NextResponse;
}
