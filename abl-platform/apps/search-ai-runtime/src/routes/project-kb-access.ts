import type { Request } from 'express';
import type { ISearchIndex } from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';

type TenantContextLike = {
  projectId?: string;
  projectScope?: string[];
  tenantId?: string;
};

type Leanable<T> = Promise<T> | { lean: () => Promise<T> };

async function resolveLean<T>(query: Leanable<T>): Promise<T> {
  if (query && typeof (query as { lean?: unknown }).lean === 'function') {
    return (query as { lean: () => Promise<T> }).lean();
  }
  return query as Promise<T>;
}

function canAccessProject(
  tenantContext: TenantContextLike | undefined,
  projectId: string,
): boolean {
  if (!tenantContext) {
    return false;
  }

  if (tenantContext.projectId && tenantContext.projectId !== projectId) {
    return false;
  }

  const scope = Array.isArray(tenantContext.projectScope)
    ? tenantContext.projectScope.filter((id) => id.length > 0)
    : [];
  return scope.length === 0 || scope.includes(projectId);
}

export async function assertProjectKbAccess(
  req: Request,
  input: {
    kbId: string;
    projectId: string;
    tenantId: string;
  },
): Promise<boolean> {
  if (!canAccessProject(req.tenantContext as TenantContextLike | undefined, input.projectId)) {
    return false;
  }

  const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
  const index = await resolveLean<ISearchIndex | null>(
    SearchIndex.findOne({
      _id: input.kbId,
      tenantId: input.tenantId,
      projectId: input.projectId,
    }),
  );

  return Boolean(index);
}

export async function requireProjectKbAccess(req: Request): Promise<{
  kbId: string;
  projectId: string;
  tenantId: string;
}> {
  const user = (req as { user?: { tenantId?: string } }).user;
  const tenantId = user?.tenantId;
  const { kbId, projectId } = req.params;
  if (!tenantId || !kbId || !projectId) {
    throw new Error('UNAUTHORIZED: Missing user or route context');
  }

  const allowed = await assertProjectKbAccess(req, { kbId, projectId, tenantId });
  if (!allowed) {
    throw new Error('NOT_FOUND: Knowledge base not found');
  }

  return { kbId, projectId, tenantId };
}
