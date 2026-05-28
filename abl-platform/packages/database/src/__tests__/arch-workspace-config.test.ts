import { describe, test, expect } from 'vitest';
import { ArchWorkspaceConfig } from '../models/arch-workspace-config.model.js';

describe('ArchWorkspaceConfig Model', () => {
  test('schema has required fields', () => {
    const schema = ArchWorkspaceConfig.schema;
    expect(schema.path('tenantId')).toBeDefined();
    expect(schema.path('modelId')).toBeDefined();
    expect(schema.path('provider')).toBeDefined();
    expect(schema.path('usePlatformCredits')).toBeDefined();
    expect(schema.path('maxTokensChat')).toBeDefined();
    expect(schema.path('maxTokensGenerate')).toBeDefined();
    expect(schema.path('temperature')).toBeDefined();
    expect(schema.path('rateLimitRpm')).toBeDefined();
    expect(schema.path('rateLimitRph')).toBeDefined();
    expect(schema.path('isActive')).toBeDefined();
    expect(schema.path('tenantModelId')).toBeDefined();
    expect(schema.path('systemPromptOverride')).toBeDefined();
    expect(schema.path('encryptedApiKey')).toBeDefined();
    expect(schema.path('updatedBy')).toBeDefined();
  });

  test('tenantId has unique index', () => {
    const indexes = ArchWorkspaceConfig.schema.indexes();
    const hasTenantIndex = indexes.some(
      ([fields]: [Record<string, number>]) => fields.tenantId === 1,
    );
    expect(hasTenantIndex).toBe(true);
  });

  test('defaults are set correctly', () => {
    const doc = new ArchWorkspaceConfig({ tenantId: 'test-tenant' });
    expect(doc.modelId).toBe('claude-sonnet-4-20250514');
    expect(doc.provider).toBe('anthropic');
    expect(doc.usePlatformCredits).toBe(true);
    expect(doc.maxTokensChat).toBe(2048);
    expect(doc.maxTokensGenerate).toBe(8192);
    expect(doc.temperature).toBe(0.7);
    expect(doc.rateLimitRpm).toBe(0);
    expect(doc.rateLimitRph).toBe(0);
    expect(doc.isActive).toBe(true);
  });
});
