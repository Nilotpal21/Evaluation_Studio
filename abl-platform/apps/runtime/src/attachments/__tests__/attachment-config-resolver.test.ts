import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database models before importing the resolver
vi.mock('@agent-platform/database', () => ({
  ProjectAttachmentConfig: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
  TenantAttachmentConfig: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { resolveAttachmentConfig, PLATFORM_DEFAULTS } from '../attachment-config-resolver.js';
import { ProjectAttachmentConfig, TenantAttachmentConfig } from '@agent-platform/database';

// Helper to wire up the findOne().lean() chain
function mockFindOne(model: any, result: any) {
  (model.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
    lean: vi.fn().mockResolvedValue(result),
  });
}

describe('resolveAttachmentConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to null (no config found)
    mockFindOne(ProjectAttachmentConfig, null);
    mockFindOne(TenantAttachmentConfig, null);
  });

  it('returns platform defaults when neither project nor tenant config exists', async () => {
    const result = await resolveAttachmentConfig('tenant-1', 'project-1');

    expect(result).toEqual(PLATFORM_DEFAULTS);
    expect(ProjectAttachmentConfig.findOne).toHaveBeenCalledWith({
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
    expect(TenantAttachmentConfig.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
    });
  });

  it('uses tenant config as fallback when no project config exists', async () => {
    mockFindOne(TenantAttachmentConfig, {
      tenantId: 'tenant-1',
      maxFileSizeBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/png'],
      piiPolicy: 'block',
      maxAttachmentsPerSession: 50,
    });

    const result = await resolveAttachmentConfig('tenant-1', 'project-1');

    expect(result.maxFileSizeBytes).toBe(10 * 1024 * 1024);
    expect(result.allowedMimeTypes).toEqual(['image/png']);
    expect(result.piiPolicy).toBe('block');
    expect(result.maxFilesPerSession).toBe(50);
    // enabled has no tenant-level field, so falls back to platform default
    expect(result.enabled).toBe(true);
  });

  it('project config overrides tenant config', async () => {
    mockFindOne(ProjectAttachmentConfig, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      enabled: false,
      maxFileSizeBytes: 5 * 1024 * 1024,
      allowedMimeTypes: ['application/pdf'],
      piiPolicy: 'allow',
    });

    mockFindOne(TenantAttachmentConfig, {
      tenantId: 'tenant-1',
      maxFileSizeBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/png'],
      piiPolicy: 'block',
      maxAttachmentsPerSession: 50,
    });

    const result = await resolveAttachmentConfig('tenant-1', 'project-1');

    expect(result.enabled).toBe(false);
    expect(result.maxFileSizeBytes).toBe(5 * 1024 * 1024);
    expect(result.allowedMimeTypes).toEqual(['application/pdf']);
    expect(result.piiPolicy).toBe('allow');
    // maxFilesPerSession is not in project config, falls to tenant
    expect(result.maxFilesPerSession).toBe(50);
  });

  it('project null fields fall through to tenant config', async () => {
    mockFindOne(ProjectAttachmentConfig, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      enabled: true,
      maxFileSizeBytes: null,
      allowedMimeTypes: null,
      piiPolicy: null,
    });

    mockFindOne(TenantAttachmentConfig, {
      tenantId: 'tenant-1',
      maxFileSizeBytes: 15 * 1024 * 1024,
      allowedMimeTypes: ['image/jpeg'],
      piiPolicy: 'block',
      maxAttachmentsPerSession: 75,
    });

    const result = await resolveAttachmentConfig('tenant-1', 'project-1');

    expect(result.enabled).toBe(true);
    expect(result.maxFileSizeBytes).toBe(15 * 1024 * 1024);
    expect(result.allowedMimeTypes).toEqual(['image/jpeg']);
    expect(result.piiPolicy).toBe('block');
    expect(result.maxFilesPerSession).toBe(75);
  });

  it('enabled: false is respected (falsy but not null)', async () => {
    mockFindOne(ProjectAttachmentConfig, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      enabled: false,
      maxFileSizeBytes: null,
      allowedMimeTypes: null,
      piiPolicy: null,
    });

    const result = await resolveAttachmentConfig('tenant-1', 'project-1');

    expect(result.enabled).toBe(false);
  });

  it('maxFileSizeBytes: 0 is respected (falsy but not null)', async () => {
    mockFindOne(TenantAttachmentConfig, {
      tenantId: 'tenant-1',
      maxFileSizeBytes: 0,
      allowedMimeTypes: [],
      piiPolicy: 'redact',
      maxAttachmentsPerSession: 100,
    });

    const result = await resolveAttachmentConfig('tenant-1', 'project-1');

    // 0 is a valid value, not null/undefined, so it should be used
    expect(result.maxFileSizeBytes).toBe(0);
  });

  it('defaultProcessingMode resolves from project override, falls through null to platform default', async () => {
    // With project override
    mockFindOne(ProjectAttachmentConfig, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      enabled: null,
      maxFileSizeBytes: null,
      allowedMimeTypes: null,
      piiPolicy: null,
      defaultProcessingMode: 'metadata_only',
    });

    let result = await resolveAttachmentConfig('tenant-1', 'project-1');
    expect(result.defaultProcessingMode).toBe('metadata_only');

    // With null project override — falls through to platform default ('full')
    mockFindOne(ProjectAttachmentConfig, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      enabled: null,
      maxFileSizeBytes: null,
      allowedMimeTypes: null,
      piiPolicy: null,
      defaultProcessingMode: null,
    });

    result = await resolveAttachmentConfig('tenant-1', 'project-1');
    expect(result.defaultProcessingMode).toBe('full');

    // With no project config at all — platform default
    mockFindOne(ProjectAttachmentConfig, null);
    result = await resolveAttachmentConfig('tenant-1', 'project-1');
    expect(result.defaultProcessingMode).toBe('full');
  });

  it('empty allowedMimeTypes array is respected (not treated as missing)', async () => {
    mockFindOne(ProjectAttachmentConfig, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      enabled: null,
      maxFileSizeBytes: null,
      allowedMimeTypes: [],
      piiPolicy: null,
    });

    const result = await resolveAttachmentConfig('tenant-1', 'project-1');

    // Empty array means "all types allowed" — it should NOT fall through
    expect(result.allowedMimeTypes).toEqual([]);
  });
});
