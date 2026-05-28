import { describe, expect, it } from 'vitest';
import { CreateProjectToolSchema } from '../validation/project-tool-schemas.js';

describe('CreateProjectToolSchema — SearchAI', () => {
  it('accepts SearchAI typed create payload without trusting a client tenant_id', () => {
    const result = CreateProjectToolSchema.safeParse({
      name: 'search_docs',
      toolType: 'searchai',
      description: 'Search documentation',
      parameters: [{ name: 'query', type: 'string', description: 'Query', required: true }],
      returnType: 'object',
      indexId: 'idx_docs',
      kbName: 'Docs',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect('tenantId' in result.data).toBe(false);
  });
});
