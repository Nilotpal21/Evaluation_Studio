import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveProjectRuntimeConfig } from '../services/config/project-runtime-config-resolver.js';
import { isDatabaseReady } from '../db/index.js';

const mockGetProjectExportReadinessIssues = vi.hoisted(() => vi.fn());

// Mock the database import
vi.mock('@agent-platform/database', () => ({
  ProjectRuntimeConfig: {
    findOne: vi.fn(),
  },
}));

vi.mock('../db/index.js', () => ({
  isDatabaseReady: vi.fn(() => true),
}));

vi.mock('@agent-platform/project-io', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProjectExportReadinessIssues: (...args: unknown[]) =>
    mockGetProjectExportReadinessIssues(...args),
}));

describe('resolveProjectRuntimeConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDatabaseReady).mockReturnValue(true);
    mockGetProjectExportReadinessIssues.mockResolvedValue([]);
  });

  it('should map nested DB schema to flat IR fields', async () => {
    const { ProjectRuntimeConfig } = await import('@agent-platform/database');
    (ProjectRuntimeConfig.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () =>
        Promise.resolve({
          tenantId: 't1',
          projectId: 'p1',
          extraction: {
            strategy: 'hybrid',
            nlu_provider: 'advanced',
            advanced_sidecar_url: 'http://kore-nlu:8090',
            advanced_sidecar_timeout_ms: 3000,
            advanced_sidecar_circuit_breaker_threshold: 5,
          },
          multi_intent: {
            enabled: true,
            strategy: 'disambiguate',
            max_intents: 5,
            confidence_threshold: 0.7,
            queue_max_age_ms: 300_000,
          },
          inference: {
            confidence: 0.9,
            confirm: false,
            model_tier: 'balanced',
            max_fields_per_pass: 5,
          },
          conversion: { currency_mode: 'live', currency_api_url: 'https://api.example.com' },
          compaction: {
            model: 'gpt-4o-mini',
            tool_results: {
              strategy: 'truncate',
              max_chars: 4096,
              keep_recent: 1,
            },
            prior_turns: {
              strategy: 'compact',
              assistant_preview_chars: 80,
            },
          },
          pipeline: {
            enabled: true,
            mode: 'parallel',
            model: 'qwen35-a3b-35b',
            shortCircuit: { enabled: true, confidenceThreshold: 0.93 },
            toolFilter: { enabled: false, maxTools: 4 },
            keywordVeto: { enabled: false, keywords: ['refund'] },
            intentBridge: {
              enabled: true,
              programmaticThreshold: 0.91,
              guidedThreshold: 0.55,
              outOfScopeDecline: false,
              multiIntentSignal: true,
            },
          },
          lookup_tables: [
            {
              name: 'cities',
              source: 'inline',
              values: ['NYC', 'LA'],
              case_sensitive: false,
              fuzzy_match: true,
              fuzzy_threshold: 0.9,
            },
          ],
        }),
    });

    const result = await resolveProjectRuntimeConfig('t1', 'p1');

    expect(result).toBeDefined();
    expect(result!.extraction_strategy).toBe('hybrid');
    expect(result!.nlu_provider).toBe('advanced');
    expect(result!.advanced_sidecar_url).toBe('http://kore-nlu:8090');
    expect(result!.advanced_sidecar_timeout_ms).toBe(3000);
    expect(result!.advanced_sidecar_circuit_breaker_threshold).toBe(5);
    expect(result!.multi_intent.enabled).toBe(true);
    expect(result!.multi_intent.strategy).toBe('disambiguate');
    expect(result!.multi_intent.max_intents).toBe(5);
    expect(result!.multi_intent.confidence_threshold).toBe(0.7);
    expect(result!.multi_intent.queue_max_age_ms).toBe(300_000);
    expect(result!.inference.confidence).toBe(0.9);
    expect(result!.inference.confirm).toBe(false);
    expect(result!.inference.model_tier).toBe('balanced');
    expect(result!.inference.max_fields_per_pass).toBe(5);
    expect(result!.conversion.currency_mode).toBe('live');
    expect(result!.conversion.currency_api_url).toBe('https://api.example.com');
    expect(result!.compaction).toEqual({
      model: 'gpt-4o-mini',
      tool_results: {
        strategy: 'truncate',
        max_chars: 4096,
        keep_recent: 1,
      },
      prior_turns: {
        strategy: 'compact',
        assistant_preview_chars: 80,
      },
    });
    expect(result!.pipeline).toEqual({
      enabled: true,
      mode: 'parallel',
      modelSource: 'default',
      tenantModelId: undefined,
      shortCircuit: { enabled: true, confidenceThreshold: 0.93 },
      toolFilter: { enabled: false, maxTools: 4 },
      keywordVeto: { enabled: false, keywords: ['refund'] },
      intentBridge: {
        enabled: true,
        programmaticThreshold: 0.91,
        guidedThreshold: 0.55,
        outOfScopeDecline: false,
        multiIntentSignal: true,
      },
    });
    expect(result!.lookup_tables).toHaveLength(1);
    expect(result!.lookup_tables[0].name).toBe('cities');
    expect(result!.lookup_tables[0].source).toBe('inline');
    expect(result!.lookup_tables[0].values).toEqual(['NYC', 'LA']);
    expect(result!.lookup_tables[0].fuzzy_match).toBe(true);
    expect(result!.lookup_tables[0].fuzzy_threshold).toBe(0.9);

    expect(ProjectRuntimeConfig.findOne).toHaveBeenCalledWith({
      tenantId: 't1',
      projectId: 'p1',
    });
  });

  it('should return undefined when no DB record exists', async () => {
    const { ProjectRuntimeConfig } = await import('@agent-platform/database');
    (ProjectRuntimeConfig.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.resolve(null),
    });

    const result = await resolveProjectRuntimeConfig('t1', 'p1');
    expect(result).toBeUndefined();
  });

  it('should return undefined on DB error (graceful degradation)', async () => {
    const { ProjectRuntimeConfig } = await import('@agent-platform/database');
    (ProjectRuntimeConfig.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.reject(new Error('MongoDB connection refused')),
    });

    const result = await resolveProjectRuntimeConfig('t1', 'p1');
    expect(result).toBeUndefined();
  });

  it('should reject invalid persisted runtime config instead of degrading to defaults', async () => {
    const { ProjectRuntimeConfig } = await import('@agent-platform/database');
    (ProjectRuntimeConfig.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () =>
        Promise.resolve({
          tenantId: 't1',
          projectId: 'p1',
          extraction: {
            nlu_provider: 'advanced',
          },
        }),
    });
    mockGetProjectExportReadinessIssues.mockResolvedValueOnce([
      {
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: 'advanced_sidecar_url is required when nlu_provider is advanced',
            source: 'export-runtime-config-readiness',
          },
        ],
      },
    ]);

    await expect(resolveProjectRuntimeConfig('t1', 'p1')).rejects.toThrow(
      'Project runtime config has validation errors',
    );
  });

  it('should return undefined without querying when database is not ready', async () => {
    const { ProjectRuntimeConfig } = await import('@agent-platform/database');
    vi.mocked(isDatabaseReady).mockReturnValue(false);

    const result = await resolveProjectRuntimeConfig('t1', 'p1');

    expect(result).toBeUndefined();
    expect(ProjectRuntimeConfig.findOne).not.toHaveBeenCalled();
  });

  it('should use defaults for missing nested fields', async () => {
    const { ProjectRuntimeConfig } = await import('@agent-platform/database');
    (ProjectRuntimeConfig.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () =>
        Promise.resolve({
          tenantId: 't1',
          projectId: 'p1',
          // All nested configs missing
        }),
    });

    const result = await resolveProjectRuntimeConfig('t1', 'p1');
    expect(result).toBeDefined();
    expect(result!.extraction_strategy).toBe('auto');
    expect(result!.nlu_provider).toBe('standard');
    expect(result!.advanced_sidecar_url).toBeUndefined();
    expect(result!.advanced_sidecar_timeout_ms).toBeUndefined();
    expect(result!.advanced_sidecar_circuit_breaker_threshold).toBeUndefined();
    expect(result!.multi_intent.enabled).toBe(true);
    expect(result!.multi_intent.strategy).toBe('primary_queue');
    expect(result!.multi_intent.max_intents).toBe(3);
    expect(result!.multi_intent.confidence_threshold).toBe(0.6);
    expect(result!.multi_intent.queue_max_age_ms).toBe(600_000);
    expect(result!.inference.confidence).toBe(0.8);
    expect(result!.inference.confirm).toBe(true);
    expect(result!.inference.model_tier).toBe('fast');
    expect(result!.inference.max_fields_per_pass).toBe(3);
    expect(result!.conversion.currency_mode).toBe('static');
    expect(result!.conversion.currency_api_url).toBeUndefined();
    expect(result!.pipeline).toBeUndefined();
    expect(result!.lookup_tables).toEqual([]);
  });

  it('should handle partially populated nested fields', async () => {
    const { ProjectRuntimeConfig } = await import('@agent-platform/database');
    (ProjectRuntimeConfig.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () =>
        Promise.resolve({
          tenantId: 't1',
          projectId: 'p1',
          extraction: { strategy: 'llm' },
          multi_intent: { enabled: false },
          // inference and conversion missing
        }),
    });

    const result = await resolveProjectRuntimeConfig('t1', 'p1');
    expect(result).toBeDefined();
    expect(result!.extraction_strategy).toBe('llm');
    expect(result!.multi_intent.enabled).toBe(false);
    // Rest of multi_intent should have defaults
    expect(result!.multi_intent.strategy).toBe('primary_queue');
    expect(result!.multi_intent.max_intents).toBe(3);
    // inference and conversion should be defaults
    expect(result!.inference.confidence).toBe(0.8);
    expect(result!.conversion.currency_mode).toBe('static');
  });

  describe('nlu_provider field mapping', () => {
    it('should map nlu_provider from DB extraction section', async () => {
      const { ProjectRuntimeConfig } = await import('@agent-platform/database');
      (ProjectRuntimeConfig.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
        lean: () =>
          Promise.resolve({
            tenantId: 't1',
            projectId: 'p1',
            extraction: {
              strategy: 'auto',
              nlu_provider: 'advanced',
              advanced_sidecar_url: 'http://kore-nlu:8090',
              advanced_sidecar_timeout_ms: 5000,
              advanced_sidecar_circuit_breaker_threshold: 10,
            },
          }),
      });

      const result = await resolveProjectRuntimeConfig('t1', 'p1');

      expect(result).toBeDefined();
      expect(result!.nlu_provider).toBe('advanced');
      expect(result!.advanced_sidecar_url).toBe('http://kore-nlu:8090');
      expect(result!.advanced_sidecar_timeout_ms).toBe(5000);
      expect(result!.advanced_sidecar_circuit_breaker_threshold).toBe(10);
    });

    it('should default nlu_provider to standard when not in DB', async () => {
      const { ProjectRuntimeConfig } = await import('@agent-platform/database');
      (ProjectRuntimeConfig.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
        lean: () =>
          Promise.resolve({
            tenantId: 't1',
            projectId: 'p1',
            extraction: { strategy: 'auto' },
          }),
      });

      const result = await resolveProjectRuntimeConfig('t1', 'p1');

      expect(result).toBeDefined();
      expect(result!.nlu_provider).toBe('standard');
      expect(result!.advanced_sidecar_url).toBeUndefined();
      expect(result!.advanced_sidecar_timeout_ms).toBeUndefined();
      expect(result!.advanced_sidecar_circuit_breaker_threshold).toBeUndefined();
    });

    it('should default nlu_provider to standard when extraction section is missing', async () => {
      const { ProjectRuntimeConfig } = await import('@agent-platform/database');
      (ProjectRuntimeConfig.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
        lean: () =>
          Promise.resolve({
            tenantId: 't1',
            projectId: 'p1',
          }),
      });

      const result = await resolveProjectRuntimeConfig('t1', 'p1');

      expect(result).toBeDefined();
      expect(result!.nlu_provider).toBe('standard');
      expect(result!.advanced_sidecar_url).toBeUndefined();
      expect(result!.advanced_sidecar_timeout_ms).toBeUndefined();
      expect(result!.advanced_sidecar_circuit_breaker_threshold).toBeUndefined();
    });
  });

  it('lookup table preserves explicit false/0 values (does not default over them)', async () => {
    const { ProjectRuntimeConfig } = await import('@agent-platform/database');
    (ProjectRuntimeConfig.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () =>
        Promise.resolve({
          tenantId: 't1',
          projectId: 'p1',
          lookup_tables: [
            {
              name: 'keywords',
              source: 'inline',
              values: ['foo', 'bar'],
              case_sensitive: false, // explicit false, not undefined
              fuzzy_match: false, // explicit false, not undefined
              fuzzy_threshold: 0, // explicit 0, not undefined
            },
          ],
        }),
    });

    const result = await resolveProjectRuntimeConfig('t1', 'p1');

    expect(result).toBeDefined();
    expect(result!.lookup_tables).toHaveLength(1);
    expect(result!.lookup_tables[0].case_sensitive).toBe(false);
    expect(result!.lookup_tables[0].fuzzy_match).toBe(false);
    expect(result!.lookup_tables[0].fuzzy_threshold).toBe(0);
  });
});
