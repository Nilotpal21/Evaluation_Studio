import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@agent-platform/database/models', () => ({
  ModuleRelease: { findOne: vi.fn() },
  ModuleEnvironmentPointer: { findOne: vi.fn() },
}));

import { ModuleRelease, ModuleEnvironmentPointer } from '@agent-platform/database/models';
import { resolveSelector } from '../module-release/module-selector.js';
import type { ModuleSelector } from '../module-release/module-selector.js';

const TENANT = 'tenant-1';
const MODULE_PROJECT = 'mod-proj-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSelector — version selector', () => {
  it('returns releaseId and version on match', async () => {
    (ModuleRelease.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      _id: 'rel-100',
      version: '1.0.0',
    });

    const result = await resolveSelector(TENANT, MODULE_PROJECT, {
      type: 'version',
      value: '1.0.0',
    });

    expect(result).toEqual({ releaseId: 'rel-100', version: '1.0.0' });
    expect(ModuleRelease.findOne).toHaveBeenCalledWith({
      tenantId: TENANT,
      moduleProjectId: MODULE_PROJECT,
      version: '1.0.0',
      archivedAt: null,
    });
  });

  it('returns error when version not found', async () => {
    (ModuleRelease.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await resolveSelector(TENANT, MODULE_PROJECT, {
      type: 'version',
      value: '9.9.9',
    });

    expect(result).toEqual({ error: 'Version 9.9.9 not found or archived' });
  });

  it('returns error when release is archived (findOne filters archivedAt: null)', async () => {
    // The query includes archivedAt: null, so archived releases return null
    (ModuleRelease.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await resolveSelector(TENANT, MODULE_PROJECT, {
      type: 'version',
      value: '1.0.0',
    });

    expect(result).toEqual({ error: 'Version 1.0.0 not found or archived' });
  });
});

describe('resolveSelector — environment selector', () => {
  it('returns releaseId and version when pointer and release exist', async () => {
    (ModuleEnvironmentPointer.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      moduleReleaseId: 'rel-200',
    });
    (ModuleRelease.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      _id: 'rel-200',
      version: '2.0.0',
    });

    const result = await resolveSelector(TENANT, MODULE_PROJECT, {
      type: 'environment',
      value: 'production',
    });

    expect(result).toEqual({ releaseId: 'rel-200', version: '2.0.0' });
    expect(ModuleEnvironmentPointer.findOne).toHaveBeenCalledWith({
      tenantId: TENANT,
      moduleProjectId: MODULE_PROJECT,
      environment: 'production',
    });
    expect(ModuleRelease.findOne).toHaveBeenCalledWith({
      _id: 'rel-200',
      tenantId: TENANT,
      moduleProjectId: MODULE_PROJECT,
      archivedAt: null,
    });
  });

  it('returns error when environment pointer does not exist', async () => {
    (ModuleEnvironmentPointer.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await resolveSelector(TENANT, MODULE_PROJECT, {
      type: 'environment',
      value: 'staging',
    });

    expect(result).toEqual({
      error: "No release promoted to 'staging' environment. Promote a release first.",
    });
    expect(ModuleRelease.findOne).not.toHaveBeenCalled();
  });

  it('returns error when pointer points to archived release', async () => {
    (ModuleEnvironmentPointer.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      moduleReleaseId: 'rel-archived',
    });
    (ModuleRelease.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await resolveSelector(TENANT, MODULE_PROJECT, {
      type: 'environment',
      value: 'production',
    });

    expect(result).toEqual({ error: 'Promoted release has been archived' });
  });

  it('returns error when pointer release has been deleted', async () => {
    (ModuleEnvironmentPointer.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      moduleReleaseId: 'rel-deleted',
    });
    (ModuleRelease.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await resolveSelector(TENANT, MODULE_PROJECT, {
      type: 'environment',
      value: 'production',
    });

    expect(result).toEqual({ error: 'Promoted release has been archived' });
  });
});

describe('resolveSelector — tenant isolation', () => {
  it('returns error when queried with wrong tenantId', async () => {
    (ModuleRelease.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await resolveSelector('wrong-tenant', MODULE_PROJECT, {
      type: 'version',
      value: '1.0.0',
    });

    expect(result).toEqual({ error: 'Version 1.0.0 not found or archived' });
    expect(ModuleRelease.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'wrong-tenant' }),
    );
  });

  it('environment selector with wrong tenantId returns not found', async () => {
    (ModuleEnvironmentPointer.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await resolveSelector('wrong-tenant', MODULE_PROJECT, {
      type: 'environment',
      value: 'production',
    });

    expect(result).toEqual({
      error: "No release promoted to 'production' environment. Promote a release first.",
    });
  });
});

describe('resolveSelector — unknown selector type', () => {
  it('returns error for unknown selector type', async () => {
    const result = await resolveSelector(TENANT, MODULE_PROJECT, {
      type: 'unknown' as ModuleSelector['type'],
      value: 'foo',
    });

    expect(result).toEqual({ error: 'Unknown selector type: unknown' });
  });
});
