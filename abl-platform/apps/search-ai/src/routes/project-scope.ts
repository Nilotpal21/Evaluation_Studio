import type { Response } from 'express';
import type { TenantContextData } from '@agent-platform/shared-auth';

type ProjectScopeFilter = string | { $in: string[] };

function normalizeProjectScope(projectScope: readonly string[] | undefined): string[] {
  if (!Array.isArray(projectScope)) {
    return [];
  }
  return [...new Set(projectScope.filter((projectId) => projectId.length > 0))].sort();
}

export function canAccessProject(
  tenantContext: Pick<TenantContextData, 'projectId' | 'projectScope'>,
  projectId: string,
): boolean {
  const scopedProjectId = tenantContext.projectId;
  const projectScope = normalizeProjectScope(tenantContext.projectScope);

  if (scopedProjectId && scopedProjectId !== projectId) {
    return false;
  }

  return projectScope.length === 0 || projectScope.includes(projectId);
}

export function resolveProjectFilter(
  tenantContext: Pick<TenantContextData, 'projectId' | 'projectScope'>,
): ProjectScopeFilter | undefined {
  const projectScope = normalizeProjectScope(tenantContext.projectScope);
  if (tenantContext.projectId) {
    if (projectScope.length > 0 && !projectScope.includes(tenantContext.projectId)) {
      return { $in: [] };
    }
    return tenantContext.projectId;
  }

  if (projectScope.length > 0) {
    return { $in: projectScope };
  }

  return undefined;
}

export function applyProjectScopeFilter(
  filter: Record<string, unknown>,
  tenantContext: Pick<TenantContextData, 'projectId' | 'projectScope'>,
): Record<string, unknown> {
  const projectFilter = resolveProjectFilter(tenantContext);
  if (projectFilter) {
    return { ...filter, projectId: projectFilter };
  }
  return filter;
}

export function respondProjectScopedNotFound(
  res: Response,
  code = 'NOT_FOUND',
  message = 'Resource not found',
): void {
  res.status(404).json({
    success: false,
    error: { code, message },
  });
}
