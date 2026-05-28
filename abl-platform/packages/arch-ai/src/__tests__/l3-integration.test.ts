import { describe, expect, it } from 'vitest';
import { MAX_KNOWLEDGE_TOKENS, selectKnowledgeCards } from '../knowledge/card-router.js';

describe('Knowledge card selection with L3', () => {
  it('returns L0 content when no user message', () => {
    const result = selectKnowledgeCards();
    expect(result.selectedIds).toContain('platform-limits');
    expect(result.l3Chunks).toHaveLength(0);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('matches L2 cards by regex and stays within budget', () => {
    const result = selectKnowledgeCards('how do I use GATHER to collect user information', 6000);
    expect(result.selectedIds).toContain('gather-fields');
    expect(result.estimatedTokens).toBeLessThanOrEqual(MAX_KNOWLEDGE_TOKENS);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('deduplicates L3 chunks against L2 card sources', () => {
    const result = selectKnowledgeCards('GATHER field validation and collection');
    expect(result.selectedIds).toContain('gather-fields');
    for (const chunk of result.l3Chunks) {
      expect(chunk.file).not.toBe('abl-reference/gather.mdx');
    }
  });

  it('respects total token budget across L0 + L2 + L3', () => {
    const result = selectKnowledgeCards('FLOW step branching ON_INPUT tools GATHER memory');
    expect(result.estimatedTokens).toBeLessThanOrEqual(MAX_KNOWLEDGE_TOKENS);
  });

  it('returns l3Chunks metadata for debugging', () => {
    const result = selectKnowledgeCards('supervisor routing multi-agent orchestration');
    if (result.l3Chunks.length > 0) {
      const chunk = result.l3Chunks[0];
      expect(chunk.file).toBeTruthy();
      expect(chunk.heading).toBeTruthy();
      expect(chunk.score).toBeGreaterThan(0);
    }
  });
});
