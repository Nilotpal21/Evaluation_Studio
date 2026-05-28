import { describe, expect, it } from 'vitest';
import { MAX_KNOWLEDGE_TOKENS, selectKnowledgeCards } from '../knowledge/card-router.js';

describe('L3 file-grouped retrieval', () => {
  it('returns l3Chunks grouped by file rather than scattered', () => {
    const result = selectKnowledgeCards('conversation api endpoints');

    expect(result.l3Chunks.length).toBeGreaterThan(0);

    const fileChunkCounts = new Map<string, number>();
    for (const chunk of result.l3Chunks) {
      fileChunkCounts.set(chunk.file, (fileChunkCounts.get(chunk.file) ?? 0) + 1);
    }
    const maxChunksFromOneFile = Math.max(...fileChunkCounts.values());
    expect(maxChunksFromOneFile).toBeGreaterThanOrEqual(2);
  });

  it('does not exceed token budget', () => {
    const result = selectKnowledgeCards('deploy agent production channels');
    expect(result.estimatedTokens).toBeLessThanOrEqual(MAX_KNOWLEDGE_TOKENS);
  });
});
