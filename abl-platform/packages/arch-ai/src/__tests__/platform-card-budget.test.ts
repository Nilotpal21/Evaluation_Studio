import { describe, expect, it } from 'vitest';
import { selectKnowledgeCards } from '../knowledge/card-router.js';

describe('Platform knowledge budget', () => {
  it('uses 14000 token default budget', () => {
    const result = selectKnowledgeCards('tell me about gather fields');
    expect(result.estimatedTokens).toBeLessThanOrEqual(14000);
    expect(result.selectedIds).toContain('platform-limits');
  });

  it('accepts pageContext parameter without error', () => {
    const result = selectKnowledgeCards('what should I do?', undefined, undefined, {
      area: 'project',
      page: 'deployments',
    });
    expect(result.selectedIds).toBeDefined();
    expect(result.selectedIds).toContain('platform-limits');
  });

  it('still respects explicit maxTokens override', () => {
    const result = selectKnowledgeCards('tell me about flow', 2000);
    expect(result.estimatedTokens).toBeLessThanOrEqual(2000);
  });
});
