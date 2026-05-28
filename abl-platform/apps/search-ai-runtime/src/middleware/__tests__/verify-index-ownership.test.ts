import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOwnershipCache, verifyIndexOwnership } from '../verify-index-ownership.js';

const db = vi.hoisted(() => ({
  searchIndexFindOne: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: () => ({
    findOne: db.searchIndexFindOne,
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function lean(value: unknown) {
  return {
    lean: vi.fn(async () => value),
  };
}

function makeResponse() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('verifyIndexOwnership', () => {
  beforeEach(() => {
    clearOwnershipCache();
    db.searchIndexFindOne.mockReset();
  });

  it('scopes index ownership checks and cache entries by project when projectId is present', async () => {
    const indexInProjectB = {
      _id: 'idx-shared-tenant',
      tenantId: 'tenant-1',
      projectId: 'project-b',
    };

    db.searchIndexFindOne.mockImplementation((filter: Record<string, unknown>) => {
      if (filter.projectId === 'project-a') {
        return lean(null);
      }
      return lean(indexInProjectB);
    });

    const projectBNext = vi.fn();
    await verifyIndexOwnership(
      {
        params: { indexId: 'idx-shared-tenant' },
        tenantContext: { tenantId: 'tenant-1', projectId: 'project-b' },
      } as any,
      makeResponse() as any,
      projectBNext,
    );

    expect(projectBNext).toHaveBeenCalledTimes(1);
    expect(db.searchIndexFindOne).toHaveBeenLastCalledWith({
      _id: 'idx-shared-tenant',
      tenantId: 'tenant-1',
      projectId: 'project-b',
    });

    const projectARes = makeResponse();
    const projectANext = vi.fn();
    await verifyIndexOwnership(
      {
        params: { indexId: 'idx-shared-tenant' },
        tenantContext: { tenantId: 'tenant-1', projectId: 'project-a' },
      } as any,
      projectARes as any,
      projectANext,
    );

    expect(projectANext).not.toHaveBeenCalled();
    expect(projectARes.status).toHaveBeenCalledWith(404);
    expect(db.searchIndexFindOne).toHaveBeenLastCalledWith({
      _id: 'idx-shared-tenant',
      tenantId: 'tenant-1',
      projectId: 'project-a',
    });
  });

  it('scopes API-key index ownership checks and cache entries by projectScope', async () => {
    const scopedIndex = {
      _id: 'idx-scoped',
      tenantId: 'tenant-1',
      projectId: 'project-b',
    };

    db.searchIndexFindOne.mockImplementation((filter: Record<string, unknown>) => {
      const projectFilter = filter.projectId as { $in?: string[] } | undefined;
      if (projectFilter?.$in?.includes('project-b')) {
        return lean(scopedIndex);
      }
      return lean(null);
    });

    const projectBNext = vi.fn();
    await verifyIndexOwnership(
      {
        params: { indexId: 'idx-scoped' },
        tenantContext: { tenantId: 'tenant-1', projectScope: ['project-b'] },
      } as any,
      makeResponse() as any,
      projectBNext,
    );

    expect(projectBNext).toHaveBeenCalledTimes(1);
    expect(db.searchIndexFindOne).toHaveBeenLastCalledWith({
      _id: 'idx-scoped',
      tenantId: 'tenant-1',
      projectId: { $in: ['project-b'] },
    });

    const projectARes = makeResponse();
    const projectANext = vi.fn();
    await verifyIndexOwnership(
      {
        params: { indexId: 'idx-scoped' },
        tenantContext: { tenantId: 'tenant-1', projectScope: ['project-a'] },
      } as any,
      projectARes as any,
      projectANext,
    );

    expect(projectANext).not.toHaveBeenCalled();
    expect(projectARes.status).toHaveBeenCalledWith(404);
    expect(db.searchIndexFindOne).toHaveBeenLastCalledWith({
      _id: 'idx-scoped',
      tenantId: 'tenant-1',
      projectId: { $in: ['project-a'] },
    });
  });
});
