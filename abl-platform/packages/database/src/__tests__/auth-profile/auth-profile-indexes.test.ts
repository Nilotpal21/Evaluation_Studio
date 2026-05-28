import { describe, it, expect } from 'vitest';
import { AuthProfile } from '../../models/auth-profile.model.js';

describe('AuthProfile indexes', () => {
  const indexes = (AuthProfile.schema as any).indexes() as Array<[Record<string, number>, any]>;

  function hasIndex(fields: Record<string, number>, opts?: Record<string, unknown>): boolean {
    return indexes.some(([f, o]) => {
      const fieldsMatch = JSON.stringify(f) === JSON.stringify(fields);
      if (!opts) return fieldsMatch;
      return (
        fieldsMatch &&
        Object.entries(opts).every(([k, v]) => JSON.stringify(o[k]) === JSON.stringify(v))
      );
    });
  }

  it('has { tenantId, scope } index', () => {
    expect(hasIndex({ tenantId: 1, scope: 1 })).toBe(true);
  });

  it('has { tenantId, projectId, scope } index', () => {
    expect(hasIndex({ tenantId: 1, projectId: 1, scope: 1 })).toBe(true);
  });

  it('has { tenantId, projectId, connector, authType } index', () => {
    expect(hasIndex({ tenantId: 1, projectId: 1, connector: 1, authType: 1 })).toBe(true);
  });

  it('has { tenantId, projectId, visibility, createdBy } index', () => {
    expect(hasIndex({ tenantId: 1, projectId: 1, visibility: 1, createdBy: 1 })).toBe(true);
  });

  it('has personal profile resolution index', () => {
    expect(hasIndex({ tenantId: 1, projectId: 1, connector: 1, visibility: 1, createdBy: 1 })).toBe(
      true,
    );
  });

  it('has { tenantId, projectId, category } index', () => {
    expect(hasIndex({ tenantId: 1, projectId: 1, category: 1 })).toBe(true);
  });

  it('has { linkedAppProfileId } index', () => {
    expect(hasIndex({ linkedAppProfileId: 1 })).toBe(true);
  });

  it('has { status, expiresAt, authType } index', () => {
    expect(hasIndex({ status: 1, expiresAt: 1, authType: 1 })).toBe(true);
  });

  it('has tenant-level shared unique name constraint (partial)', () => {
    expect(
      hasIndex(
        { tenantId: 1, name: 1, environment: 1 },
        {
          unique: true,
          partialFilterExpression: { projectId: null, visibility: 'shared' },
        },
      ),
    ).toBe(true);
  });

  it('has project-level shared unique name constraint (partial)', () => {
    expect(
      hasIndex(
        { tenantId: 1, projectId: 1, name: 1, environment: 1 },
        {
          unique: true,
          partialFilterExpression: { projectId: { $type: 'string' }, visibility: 'shared' },
        },
      ),
    ).toBe(true);
  });

  it('has tenant-level personal unique name constraint scoped by owner', () => {
    expect(
      hasIndex(
        { tenantId: 1, createdBy: 1, name: 1, environment: 1 },
        {
          unique: true,
          partialFilterExpression: { projectId: null, visibility: 'personal' },
        },
      ),
    ).toBe(true);
  });

  it('has project-level personal unique name constraint scoped by owner', () => {
    expect(
      hasIndex(
        { tenantId: 1, projectId: 1, createdBy: 1, name: 1, environment: 1 },
        {
          unique: true,
          partialFilterExpression: { projectId: { $type: 'string' }, visibility: 'personal' },
        },
      ),
    ).toBe(true);
  });
});
