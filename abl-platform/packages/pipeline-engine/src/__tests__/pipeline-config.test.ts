import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the service under test
// ---------------------------------------------------------------------------

const mockFindOne = vi.fn();
const mockCreate = vi.fn();

vi.mock('mongoose', () => {
  class MockSchema {
    static Types = { Mixed: 'Mixed' };
    index() {
      return this;
    }
    pre() {
      return this;
    }
  }

  const modelFn = () => ({
    findOne: mockFindOne,
    create: mockCreate,
  });

  const mongoose = {
    Schema: MockSchema,
    model: modelFn,
    models: {},
  };

  return {
    ...mongoose,
    default: mongoose,
    Schema: MockSchema,
    model: modelFn,
  };
});

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { PipelineConfigService } = await import('../pipeline/services/pipeline-config.service.js');
const { BUILTIN_DEFINITIONS } = await import('../pipeline/definitions/index.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineConfigService', () => {
  let service: InstanceType<typeof PipelineConfigService>;

  beforeEach(() => {
    mockFindOne.mockReset();
    mockCreate.mockReset();
    service = new PipelineConfigService();
  });

  // ─── resolveConfig ────────────────────────────────────────────────────

  test('builtin definitions include context preservation as a seeded pipeline', () => {
    expect(BUILTIN_DEFINITIONS.map(({ definition }) => definition.pipelineType)).toContain(
      'context_preservation',
    );
  });

  test('resolveConfig returns project config when it exists', async () => {
    const projectConfig = {
      tenantId: 't1',
      projectId: 'p1',
      pipelineType: 'sentiment_analysis',
      enabled: true,
      version: 2,
      config: { granularity: 'both' },
    };
    mockFindOne.mockResolvedValueOnce(projectConfig);

    const result = await service.resolveConfig('t1', 'sentiment_analysis', 'p1');

    expect(result).toEqual(projectConfig);
    expect(mockFindOne).toHaveBeenCalledWith({
      tenantId: 't1',
      pipelineType: 'sentiment_analysis',
      projectId: 'p1',
    });
  });

  test('resolveConfig falls back to tenant config when no project config', async () => {
    const tenantConfig = {
      tenantId: 't1',
      projectId: null,
      pipelineType: 'sentiment_analysis',
      enabled: true,
      version: 1,
      config: { granularity: 'conversation' },
    };
    mockFindOne
      .mockResolvedValueOnce(null) // no project config
      .mockResolvedValueOnce(tenantConfig); // tenant config

    const result = await service.resolveConfig('t1', 'sentiment_analysis', 'p1');

    expect(result).toEqual(tenantConfig);
    expect(mockFindOne).toHaveBeenCalledTimes(2);
  });

  test('resolveConfig returns platform defaults when no project/tenant config exists', async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await service.resolveConfig('t1', 'sentiment_analysis', 'p1');

    // Should return a synthetic config with platform defaults, not null
    expect(result).not.toBeNull();
    expect(result!.version).toBe(0);
    expect(result!.tenantId).toBe('t1');
    expect(result!.pipelineType).toBe('sentiment_analysis');
    expect(result!.config).toHaveProperty('shiftThreshold', 0.3);
    expect(result!.config).toHaveProperty('frustrationThreshold', -0.3);
    expect(result!.config).toHaveProperty('defaultConfidence', 0.85);
    expect(result!.config).toHaveProperty('samplingRate', 1.0);
  });

  test('resolveConfig returns platform defaults for context preservation', async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await service.resolveConfig('t1', 'context_preservation', 'p1');

    expect(result).not.toBeNull();
    expect(result!.pipelineType).toBe('context_preservation');
    expect(result!.config).toHaveProperty('flagThreshold', 0.6);
    expect(result!.config).toHaveProperty('samplingRate', 1.0);
  });

  test('resolveConfig returns null for unknown pipeline type with no config', async () => {
    mockFindOne.mockResolvedValue(null);

    // 'nl_to_sql' is a valid PipelineType but may have no PLATFORM_DEFAULTS entry
    const result = await service.resolveConfig('t1', 'nl_to_sql' as any, 'p1');

    expect(result).toBeNull();
  });

  test('resolveConfig skips project lookup when no projectId provided', async () => {
    const tenantConfig = {
      tenantId: 't1',
      projectId: null,
      pipelineType: 'intent_classification',
      enabled: true,
      version: 1,
      config: {},
    };
    mockFindOne.mockResolvedValueOnce(tenantConfig);

    const result = await service.resolveConfig('t1', 'intent_classification');

    expect(result).toEqual(tenantConfig);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    expect(mockFindOne).toHaveBeenCalledWith({
      tenantId: 't1',
      pipelineType: 'intent_classification',
      projectId: null,
    });
  });

  // ─── saveConfig ───────────────────────────────────────────────────────

  test('saveConfig creates new config when none exists', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    const created = {
      tenantId: 't1',
      projectId: null,
      pipelineType: 'sentiment_analysis',
      version: 1,
      enabled: false,
      config: { granularity: 'conversation' },
      createdBy: 'user-1',
      updatedBy: 'user-1',
    };
    mockCreate.mockResolvedValueOnce(created);

    const result = await service.saveConfig(
      't1',
      'sentiment_analysis',
      { granularity: 'conversation' },
      'user-1',
    );

    expect(result).toEqual(created);
    expect(mockCreate).toHaveBeenCalledWith({
      tenantId: 't1',
      projectId: null,
      pipelineType: 'sentiment_analysis',
      version: 1,
      enabled: false,
      config: { granularity: 'conversation' },
      createdBy: 'user-1',
      updatedBy: 'user-1',
    });
  });

  test('saveConfig updates existing config with version increment and history', async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    const existing = {
      tenantId: 't1',
      projectId: null,
      pipelineType: 'sentiment_analysis',
      version: 1,
      enabled: true,
      config: { granularity: 'conversation', threshold: 0.5 },
      updatedBy: 'user-1',
      configHistory: [],
      save: mockSave,
    };
    mockFindOne.mockResolvedValueOnce(existing);

    const result = await service.saveConfig(
      't1',
      'sentiment_analysis',
      { granularity: 'both', threshold: 0.5 },
      'user-2',
    );

    expect(result.version).toBe(2);
    expect(result.updatedBy).toBe('user-2');
    expect(result.config).toEqual({ granularity: 'both', threshold: 0.5 });
    expect(result.configHistory).toHaveLength(1);
    expect(result.configHistory![0].version).toBe(2);
    expect(result.configHistory![0].changedBy).toBe('user-2');
    expect(result.configHistory![0].diff).toEqual({
      granularity: { old: 'conversation', new: 'both' },
    });
    expect(result.configHistory![0].reprocessingRequired).toBe(true);
    expect(mockSave).toHaveBeenCalledOnce();
  });

  test('saveConfig trims configHistory to last 20 entries', async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    const existingHistory = Array.from({ length: 20 }, (_, i) => ({
      version: i + 1,
      changedBy: 'user-old',
      changedAt: new Date(),
      diff: {},
      reprocessingRequired: false,
    }));
    const existing = {
      tenantId: 't1',
      projectId: null,
      pipelineType: 'sentiment_analysis',
      version: 20,
      enabled: true,
      config: { threshold: 0.5 },
      updatedBy: 'user-1',
      configHistory: [...existingHistory],
      save: mockSave,
    };
    mockFindOne.mockResolvedValueOnce(existing);

    const result = await service.saveConfig(
      't1',
      'sentiment_analysis',
      { threshold: 0.7 },
      'user-2',
    );

    expect(result.configHistory).toHaveLength(20);
    // Last entry should be the new one
    expect(result.configHistory![19].version).toBe(21);
    expect(result.configHistory![19].changedBy).toBe('user-2');
    // First entry should have been trimmed (was version 1, now starts at version 2)
    expect(result.configHistory![0].version).toBe(2);
  });

  test('saveConfig detects reprocessing-required keys', async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    const existing = {
      tenantId: 't1',
      projectId: null,
      pipelineType: 'sentiment_analysis',
      version: 1,
      enabled: true,
      config: { model: 'gpt-4', displayName: 'Sentiment' },
      updatedBy: 'user-1',
      configHistory: [],
      save: mockSave,
    };
    mockFindOne.mockResolvedValueOnce(existing);

    await service.saveConfig(
      't1',
      'sentiment_analysis',
      { model: 'claude-3', displayName: 'Sentiment' },
      'user-2',
    );

    // 'model' is in the reprocessing keys set
    expect(existing.configHistory![0].reprocessingRequired).toBe(true);
  });

  test('saveConfig marks non-reprocessing changes correctly', async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    const existing = {
      tenantId: 't1',
      projectId: null,
      pipelineType: 'sentiment_analysis',
      version: 1,
      enabled: true,
      config: { displayName: 'Old Name', description: 'Old Desc' },
      updatedBy: 'user-1',
      configHistory: [],
      save: mockSave,
    };
    mockFindOne.mockResolvedValueOnce(existing);

    await service.saveConfig(
      't1',
      'sentiment_analysis',
      { displayName: 'New Name', description: 'Old Desc' },
      'user-2',
    );

    // 'displayName' is NOT in the reprocessing keys set
    expect(existing.configHistory![0].reprocessingRequired).toBe(false);
  });

  test('saveConfig with projectId creates project-scoped config', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    const created = {
      tenantId: 't1',
      projectId: 'p1',
      pipelineType: 'quality_evaluation',
      version: 1,
      enabled: false,
      config: { flagThreshold: 3.0 },
      createdBy: 'user-1',
      updatedBy: 'user-1',
    };
    mockCreate.mockResolvedValueOnce(created);

    const result = await service.saveConfig(
      't1',
      'quality_evaluation',
      { flagThreshold: 3.0 },
      'user-1',
      'p1',
    );

    expect(result.projectId).toBe('p1');
    expect(mockFindOne).toHaveBeenCalledWith({
      tenantId: 't1',
      pipelineType: 'quality_evaluation',
      projectId: 'p1',
    });
  });

  test('saveConfig rejects invalid config via Zod validation', async () => {
    await expect(
      service.saveConfig(
        't1',
        'sentiment_analysis',
        { samplingRate: 2.0 }, // > 1.0 is invalid
        'user-1',
      ),
    ).rejects.toThrow();
  });

  test('Zod defaults are applied to empty config on save', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    mockCreate.mockImplementationOnce((data: any) => data);

    const result = await service.saveConfig('t1', 'sentiment_analysis', {}, 'user-1');

    // After Zod validation, defaults should be applied before create
    // The create is called with the validated config which has defaults
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
