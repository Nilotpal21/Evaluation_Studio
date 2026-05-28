/**
 * Unit tests for Pipeline Validation Service
 *
 * Tests all 18 validation rules.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PipelineValidationService } from '../validation.service.js';
import type { ISearchPipelineDefinition } from '@agent-platform/database';
import { ProviderRegistry } from '../../provider-registry/provider-registry.js';
import type { PipelineStageProvider } from '../../provider-registry/types.js';

// Mock provider for testing
class MockExtractionProvider implements PipelineStageProvider {
  id = 'mock-extraction';
  name = 'Mock Extraction';
  type = 'extraction' as const;
  version = '1.0.0';
  description = 'Mock extraction provider';

  async execute(input: any, config: any): Promise<any> {
    return { text: 'mock' };
  }

  validateConfig(config: unknown): config is any {
    return true;
  }

  getSchema() {
    return { type: 'object' as const, properties: {} };
  }
}

// Helper to create valid pipeline
function createValidPipeline(): ISearchPipelineDefinition {
  return {
    _id: 'pipeline-123',
    tenantId: 'tenant-456',
    knowledgeBaseId: 'kb-789',
    name: 'Test Pipeline',
    description: 'Test pipeline',
    version: 1,
    status: 'active',
    isDefault: false,
    flows: [
      {
        id: 'flow-001',
        name: 'default-flow',
        description: 'Default flow',
        enabled: true,
        priority: 0,
        isDefault: true,
        stages: [
          {
            id: 'stage-001',
            name: 'extraction',
            type: 'extraction',
            provider: 'mock-extraction',
            providerConfig: {},
            onError: 'fail' as const,
            estimatedDuration: 0,
          },
        ],
        selectionRules: [],
      },
    ],
    activeEmbeddingConfig: {
      provider: 'bge-m3',
      model: 'bge-m3',
      dimensions: 1024,
    },
    createdBy: 'test-user',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ISearchPipelineDefinition;
}

describe('PipelineValidationService', () => {
  let service: PipelineValidationService;
  let registry: ProviderRegistry;

  beforeEach(() => {
    service = new PipelineValidationService();
    registry = ProviderRegistry.getInstance();
    registry.clear();
    registry.register(new MockExtractionProvider());
  });

  describe('Structure Validation', () => {
    // Rule 1: At least 1 flow
    it('should error when pipeline has no flows', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows = [];

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'NO_FLOWS',
          severity: 'error',
        }),
      );
    });

    // Rule 2: Max 50 flows
    it('should error when pipeline has more than 50 flows', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows = Array.from({ length: 51 }, (_, i) => ({
        ...pipeline.flows[0],
        id: `flow-${i}`,
        priority: i,
      }));

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'TOO_MANY_FLOWS',
          severity: 'error',
        }),
      );
    });

    // Rule 3: At least 1 stage per flow
    it('should error when flow has no stages', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages = [];

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'NO_STAGES',
          severity: 'error',
        }),
      );
    });

    // Rule 4: At least 1 enabled flow
    it('should error when no flows are enabled', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].enabled = false;

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'NO_ENABLED_FLOWS',
          severity: 'error',
        }),
      );
    });

    // Rule 5: Exactly 1 default flow (isDefault: true)
    it('should error when no default flow exists', async () => {
      const pipeline = createValidPipeline();
      (pipeline.flows[0] as any).isDefault = false;
      (pipeline.flows[0] as any).priority = 10;

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'PIPELINE_NO_DEFAULT_FLOW',
          severity: 'error',
        }),
      );
    });

    it('should error when multiple default flows exist', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows.push({
        ...pipeline.flows[0],
        id: 'flow-002',
        isDefault: true,
        priority: 0,
      } as any);

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'PIPELINE_MULTIPLE_DEFAULT_FLOWS',
          severity: 'error',
        }),
      );
    });

    it('should error when default flow has selection rules', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].selectionRules = [
        { type: 'simple', field: 'document.extension', operator: 'eq', value: 'pdf' },
      ];

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'DEFAULT_FLOW_HAS_RULES',
          severity: 'error',
        }),
      );
    });

    it('should error when default flow is disabled', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].enabled = false;
      // Add another enabled flow so Rule 4 doesn't also fire
      pipeline.flows.push({
        ...pipeline.flows[0],
        id: 'flow-user',
        enabled: true,
        isDefault: false,
        priority: 10,
      } as any);

      const result = await service.validate(pipeline);

      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'DEFAULT_FLOW_DISABLED',
          severity: 'error',
        }),
      );
    });

    it('should error when default flow priority is not 0', async () => {
      const pipeline = createValidPipeline();
      (pipeline.flows[0] as any).priority = 5;

      const result = await service.validate(pipeline);

      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'DEFAULT_FLOW_PRIORITY',
          severity: 'error',
        }),
      );
    });
  });

  describe('Uniqueness Validation', () => {
    // Rule 6: Flow IDs unique
    it('should error when duplicate flow IDs exist', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows.push({
        ...pipeline.flows[0],
        priority: 5,
      });

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'DUPLICATE_FLOW_ID',
          severity: 'error',
        }),
      );
    });

    // Rule 7: Stage IDs unique within flow
    it('should error when duplicate stage IDs exist in flow', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages.push({
        ...pipeline.flows[0].stages[0],
        name: 'enrichment',
        type: 'enrichment',
        onError: 'fail' as const,
        estimatedDuration: 1,
      });

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'DUPLICATE_STAGE_ID',
          severity: 'error',
        }),
      );
    });

    // Rule 8: Priority uniqueness (warning)
    it('should warn when duplicate priorities exist', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows.push({
        ...pipeline.flows[0],
        id: 'flow-002',
        isDefault: false,
        priority: 0,
      } as any);

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(true); // Warning, not error
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'DUPLICATE_PRIORITY',
          severity: 'warning',
        }),
      );
    });
  });

  describe('Stage Validation', () => {
    // Rule 9: Stage type valid
    it('should error when stage type is invalid', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages[0].type = 'invalid-type' as any;

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_STAGE_TYPE',
          severity: 'error',
        }),
      );
    });

    // Rule 10: Extraction before chunking
    it('should error when chunking comes before extraction', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages = [
        {
          id: 'stage-001',
          name: 'chunking',
          type: 'chunking',
          provider: 'mock-chunking',
          providerConfig: {},
          onError: 'fail' as const,
          estimatedDuration: 0,
        },
        {
          id: 'stage-002',
          name: 'extraction',
          type: 'extraction',
          provider: 'mock-extraction',
          providerConfig: {},
          onError: 'fail' as const,
          estimatedDuration: 1,
        },
      ];

      const result = await service.validate(pipeline, { skipProviderValidation: true });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_STAGE_SEQUENCE',
          severity: 'error',
          message: expect.stringMatching(/extraction/i),
        }),
      );
    });

    // Rule 11: Chunking before embedding
    it('should error when embedding comes before chunking', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages = [
        {
          id: 'stage-001',
          name: 'embedding',
          type: 'embedding',
          provider: 'bge-m3',
          providerConfig: {
            model: 'bge-m3',
            dimensions: 1024,
          },
          onError: 'fail' as const,
          estimatedDuration: 0,
        },
        {
          id: 'stage-002',
          name: 'chunking',
          type: 'chunking',
          provider: 'mock-chunking',
          providerConfig: {},
          onError: 'fail' as const,
          estimatedDuration: 1,
        },
      ];

      const result = await service.validate(pipeline, { skipProviderValidation: true });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_STAGE_SEQUENCE',
          severity: 'error',
          message: expect.stringMatching(/chunking/i),
        }),
      );
    });

    // Rule 12: Warn on duplicate stage types
    it('should warn when duplicate stage types exist', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages.push({
        id: 'stage-002',
        name: 'extraction-2',
        type: 'extraction',
        provider: 'mock-extraction',
        providerConfig: {},
        onError: 'fail' as const,
        estimatedDuration: 1,
      });

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(true); // Warning, not error
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'DUPLICATE_STAGE_TYPE',
          severity: 'warning',
        }),
      );
    });
  });

  describe('Provider Validation', () => {
    // Rule 13: Provider exists
    it('should error when provider not found', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages[0].provider = 'nonexistent-provider';

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'PROVIDER_NOT_FOUND',
          severity: 'error',
        }),
      );
    });

    // Rule 14: Fallback provider different
    it('should error when fallback provider same as primary', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages[0].fallbackProvider = 'mock-extraction';

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'FALLBACK_PROVIDER_SAME_AS_PRIMARY',
          severity: 'error',
        }),
      );
    });

    // Rule 15: Provider config valid
    it('should error when provider config invalid', async () => {
      // Create provider that rejects config
      class StrictProvider extends MockExtractionProvider {
        validateConfig(config: unknown): config is any {
          return false; // Always reject
        }
      }

      registry.clear();
      registry.register(new StrictProvider());

      const pipeline = createValidPipeline();

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_PROVIDER_CONFIG',
          severity: 'error',
        }),
      );
    });

    it('should skip provider validation when option set', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages[0].provider = 'nonexistent-provider';

      const result = await service.validate(pipeline, { skipProviderValidation: true });

      expect(result.errors).not.toContainEqual(
        expect.objectContaining({
          code: 'PROVIDER_NOT_FOUND',
        }),
      );
    });
  });

  describe('Rule Validation', () => {
    // Helper: add a non-default user flow with rules (default flow can't have rules)
    function addUserFlowWithRules(pipeline: ISearchPipelineDefinition, rules: any[]) {
      pipeline.flows.push({
        ...pipeline.flows[0],
        id: 'flow-user-rules',
        isDefault: false,
        priority: 10,
        selectionRules: rules,
      } as any);
    }

    // Rule 16: CEL expression validation
    it('should error when CEL expression is empty', async () => {
      const pipeline = createValidPipeline();
      addUserFlowWithRules(pipeline, [{ type: 'cel', celExpression: '' }]);

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_CEL_EXPRESSION',
          severity: 'error',
        }),
      );
    });

    // Rule 17: Rule field paths valid
    it('should error when rule field path invalid', async () => {
      const pipeline = createValidPipeline();
      addUserFlowWithRules(pipeline, [
        { type: 'simple', field: 'invalid.field', operator: 'eq', value: 'test' },
      ]);

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_RULE_FIELD_PATH',
          severity: 'error',
        }),
      );
    });

    it('should pass when rule field path is valid', async () => {
      const pipeline = createValidPipeline();
      // Add rules to a non-default flow (default flow can't have rules)
      pipeline.flows.push({
        ...pipeline.flows[0],
        id: 'flow-user',
        isDefault: false,
        priority: 10,
        selectionRules: [
          {
            type: 'simple',
            field: 'document.extension',
            operator: 'eq',
            value: 'pdf',
          },
        ],
      } as any);

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(true);
      expect(result.errors).not.toContainEqual(
        expect.objectContaining({
          code: 'INVALID_RULE_FIELD_PATH',
        }),
      );
    });

    // Rule 18: Rule operators valid
    it('should error when rule operator invalid', async () => {
      const pipeline = createValidPipeline();
      addUserFlowWithRules(pipeline, [
        {
          type: 'simple',
          field: 'document.extension',
          operator: 'invalid-op' as any,
          value: 'test',
        },
      ]);

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_RULE_OPERATOR',
          severity: 'error',
        }),
      );
    });

    it('should validate compound rules recursively', async () => {
      const pipeline = createValidPipeline();
      addUserFlowWithRules(pipeline, [
        {
          type: 'compound',
          logic: 'AND',
          conditions: [{ type: 'simple', field: 'invalid.field', operator: 'eq', value: 'test' }],
        },
      ]);

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_RULE_FIELD_PATH',
          severity: 'error',
        }),
      );
    });

    it('should skip CEL validation when option set', async () => {
      const pipeline = createValidPipeline();
      addUserFlowWithRules(pipeline, [{ type: 'cel', celExpression: '' }]);

      const result = await service.validate(pipeline, { skipCELValidation: true });

      expect(result.errors).not.toContainEqual(
        expect.objectContaining({
          code: 'INVALID_CEL_EXPRESSION',
        }),
      );
    });
  });

  describe('Validation Result', () => {
    it('should return valid result for valid pipeline', async () => {
      const pipeline = createValidPipeline();

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(true);
      expect(result.summary.errorCount).toBe(0);
      expect(result.summary.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should return summary with error counts', async () => {
      const pipeline = createValidPipeline();
      // Disable the default flow — triggers DEFAULT_FLOW_DISABLED (error) + NO_ENABLED_FLOWS (error)
      pipeline.flows[0].enabled = false;
      // Add a non-default flow with duplicate priority to also get a warning
      pipeline.flows.push({
        ...pipeline.flows[0],
        id: 'flow-user',
        enabled: true,
        isDefault: false,
        priority: 0,
      } as any);

      const result = await service.validate(pipeline);

      expect(result.valid).toBe(false);
      expect(result.summary.errorCount).toBeGreaterThan(0);
      expect(result.summary.warningCount).toBeGreaterThan(0); // DUPLICATE_PRIORITY warning
    });

    it('should complete validation in under 100ms for typical pipeline', async () => {
      const pipeline = createValidPipeline();

      const result = await service.validate(pipeline);

      expect(result.summary.durationMs).toBeLessThan(100);
    });
  });

  // ─── Embedding Consistency Validation ─────────────────────────────────

  describe('Embedding Consistency Validation', () => {
    it('should pass when embedding stages match activeEmbeddingConfig', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages.push({
        id: 'stage-embed',
        name: 'Embedding',
        type: 'embedding',
        provider: 'bge-m3',
        providerConfig: { model: 'bge-m3', dimensions: 1024 },
        onError: 'fail' as const,
      });

      const result = await service.validate(pipeline, { skipProviderValidation: true });

      const embeddingErrors = result.errors.filter((e) => e.code === 'EMBEDDING_CONFIG_MISMATCH');
      expect(embeddingErrors).toHaveLength(0);
    });

    it('should error when embedding stage provider mismatches activeEmbeddingConfig', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages.push({
        id: 'stage-embed',
        name: 'Embedding',
        type: 'embedding',
        provider: 'openai', // Mismatch: active config is bge-m3
        providerConfig: { model: 'text-embedding-3-small', dimensions: 1536 },
        onError: 'fail' as const,
      });

      const result = await service.validate(pipeline, { skipProviderValidation: true });

      const embeddingErrors = result.errors.filter((e) => e.code === 'EMBEDDING_CONFIG_MISMATCH');
      expect(embeddingErrors).toHaveLength(1);
      expect(embeddingErrors[0].message).toContain("provider 'openai' != 'bge-m3'");
      expect(embeddingErrors[0].severity).toBe('error');
    });

    it('should error when embedding stage model mismatches', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages.push({
        id: 'stage-embed',
        name: 'Embedding',
        type: 'embedding',
        provider: 'bge-m3',
        providerConfig: { model: 'different-model', dimensions: 1024 },
        onError: 'fail' as const,
      });

      const result = await service.validate(pipeline, { skipProviderValidation: true });

      const embeddingErrors = result.errors.filter((e) => e.code === 'EMBEDDING_CONFIG_MISMATCH');
      expect(embeddingErrors).toHaveLength(1);
      expect(embeddingErrors[0].message).toContain("model 'different-model' != 'bge-m3'");
    });

    it('should error when embedding stage dimensions mismatch', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages.push({
        id: 'stage-embed',
        name: 'Embedding',
        type: 'embedding',
        provider: 'bge-m3',
        providerConfig: { model: 'bge-m3', dimensions: 512 },
        onError: 'fail' as const,
      });

      const result = await service.validate(pipeline, { skipProviderValidation: true });

      const embeddingErrors = result.errors.filter((e) => e.code === 'EMBEDDING_CONFIG_MISMATCH');
      expect(embeddingErrors).toHaveLength(1);
      expect(embeddingErrors[0].message).toContain('dimensions 512 != 1024');
    });

    it('should skip disabled flows for embedding consistency', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows.push({
        id: 'flow-disabled',
        name: 'Disabled Flow',
        enabled: false,
        isDefault: false,
        priority: 5,
        stages: [
          {
            id: 'stage-embed-disabled',
            name: 'Mismatched Embedding',
            type: 'embedding',
            provider: 'openai', // Mismatch but flow is disabled
            providerConfig: { model: 'text-embedding-3-small' },
            onError: 'fail' as const,
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.validate(pipeline, { skipProviderValidation: true });

      const embeddingErrors = result.errors.filter((e) => e.code === 'EMBEDDING_CONFIG_MISMATCH');
      expect(embeddingErrors).toHaveLength(0);
    });

    it('should error when activeEmbeddingConfig is missing', async () => {
      const pipeline = createValidPipeline();
      delete (pipeline as any).activeEmbeddingConfig;

      const result = await service.validate(pipeline, { skipProviderValidation: true });

      const missingErrors = result.errors.filter((e) => e.code === 'MISSING_EMBEDDING_CONFIG');
      expect(missingErrors).toHaveLength(1);
    });

    it('should allow embedding stages without model/dimensions in providerConfig', async () => {
      const pipeline = createValidPipeline();
      pipeline.flows[0].stages.push({
        id: 'stage-embed',
        name: 'Embedding',
        type: 'embedding',
        provider: 'bge-m3',
        providerConfig: {}, // No model or dimensions specified
        onError: 'fail' as const,
      });

      const result = await service.validate(pipeline, { skipProviderValidation: true });

      const embeddingErrors = result.errors.filter((e) => e.code === 'EMBEDDING_CONFIG_MISMATCH');
      expect(embeddingErrors).toHaveLength(0);
    });
  });
});
