import { describe, expect, it } from 'vitest';
import { searchDocsGrouped } from '../knowledge/l3-search.js';

describe('searchDocsGrouped', () => {
  it('returns file-grouped results for conversation api query', () => {
    const results = searchDocsGrouped('conversation api chat endpoint', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);

    for (const result of results) {
      expect(result.file).toBeTruthy();
      expect(result.sections.length).toBeGreaterThan(0);
      expect(result.bestScore).toBeGreaterThan(0);
    }

    const convApi = results.find((r) => r.file.includes('conversation-api'));
    expect(convApi).toBeDefined();
  });

  it('returns empty array for nonsense query', () => {
    const results = searchDocsGrouped('xyzzy frobnicator', 5);
    expect(results).toHaveLength(0);
  });

  it('respects maxResults limit', () => {
    const results = searchDocsGrouped('agent tools configuration', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('results are sorted by bestScore descending', () => {
    const results = searchDocsGrouped('deploy production channels', 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].bestScore).toBeGreaterThanOrEqual(results[i].bestScore);
    }
  });
});
