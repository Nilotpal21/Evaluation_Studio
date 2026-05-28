import { describe, expect, it, vi } from 'vitest';
import { validateSearchAIToolBinding } from '../validate-searchai-tool-binding.js';

describe('validateSearchAIToolBinding config placeholders', () => {
  it('rejects config-backed SearchAI identity fields by default for live project tools', async () => {
    const searchIndexesRepo = {
      findOne: vi.fn(),
    };

    const result = await validateSearchAIToolBinding(
      {
        tenantId: '{{config.SEARCH_TENANT_ID}}',
        indexId: '{{config.SEARCH_INDEX_ID}}',
      },
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        searchIndexesRepo,
      },
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatchObject({
        code: 'INVALID_TOOL_BINDING',
        message: 'SearchAI tool identity fields cannot use config placeholders',
      });
    }
    expect(searchIndexesRepo.findOne).not.toHaveBeenCalled();
  });

  it('can defer DB validation for module artifact placeholder checks when explicitly allowed', async () => {
    const searchIndexesRepo = {
      findOne: vi.fn(),
    };

    const result = await validateSearchAIToolBinding(
      {
        tenantId: '{{config.SEARCH_TENANT_ID}}',
        indexId: '{{config.SEARCH_INDEX_ID}}',
      },
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        searchIndexesRepo,
        allowConfigPlaceholders: true,
      },
    );

    expect(result.valid).toBe(true);
    expect(searchIndexesRepo.findOne).not.toHaveBeenCalled();
  });
});
