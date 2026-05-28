import { describe, expect, it } from 'vitest';
import { GitSyncHistory } from '../models/git-sync-history.model.js';

describe('GitSyncHistory tenant-scoped lifecycle contract', () => {
  it('persists tenantId because Studio routes create and query history by tenant', () => {
    expect(GitSyncHistory.schema.path('tenantId')).toBeDefined();
  });

  it('indexes projectId with tenantId for route history lookups', () => {
    const indexes = GitSyncHistory.schema.indexes();

    expect(indexes).toContainEqual([
      expect.objectContaining({ projectId: 1, tenantId: 1, createdAt: -1 }),
      expect.any(Object),
    ]);
  });

  it('retains tenantId when creating history documents in memory', () => {
    const doc = new GitSyncHistory({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      direction: 'pull',
      branch: 'main',
      status: 'success',
      agentsAffected: [],
      changesSummary: { added: [], modified: [], deleted: [] },
      triggeredBy: 'user-1',
    });

    expect(doc.toObject()).toEqual(expect.objectContaining({ tenantId: 'tenant-1' }));
  });

  it('indexes projectId tenantId and status for tenant-scoped status filtering', () => {
    const indexes = GitSyncHistory.schema.indexes();

    expect(indexes).toContainEqual([
      expect.objectContaining({ projectId: 1, tenantId: 1, status: 1 }),
      expect.any(Object),
    ]);
  });
});
