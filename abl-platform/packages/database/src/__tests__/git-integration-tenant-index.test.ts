import { describe, expect, it } from 'vitest';
import { GitIntegration } from '../models/git-integration.model.js';

describe('GitIntegration tenant-aware uniqueness contract', () => {
  it('uses tenantId plus projectId for the unique integration index', () => {
    const indexes = GitIntegration.schema.indexes();

    expect(indexes).toContainEqual([
      expect.objectContaining({ tenantId: 1, projectId: 1 }),
      expect.objectContaining({ unique: true }),
    ]);
  });

  it('does not keep a projectId-only unique index that can collide across tenants', () => {
    const indexes = GitIntegration.schema.indexes();

    const hasProjectOnlyUniqueIndex = indexes.some(([fields, options]) => {
      const fieldNames = Object.keys(fields);
      return fieldNames.length === 1 && fields.projectId === 1 && options.unique === true;
    });

    expect(hasProjectOnlyUniqueIndex).toBe(false);
  });
});
