import { describe, expect, it } from 'vitest';
import { selectKnowledgeCards } from '../card-router.js';

describe('integration-failure-diagnosis card', () => {
  it('loads on "failing tool" / "agent failed" style messages', () => {
    const result = selectKnowledgeCards('My agent is failing when calling the tool', undefined, []);
    expect(result.selectedIds).toContain('integration-failure-diagnosis');
  });

  it('loads on standalone HTTP status code in message', () => {
    const result = selectKnowledgeCards(
      'The integration is returning 401 every time',
      undefined,
      [],
    );
    expect(result.selectedIds).toContain('integration-failure-diagnosis');
  });

  it('does NOT load on unrelated message', () => {
    const result = selectKnowledgeCards('rename my supervisor agent', undefined, []);
    expect(result.selectedIds).not.toContain('integration-failure-diagnosis');
  });
});
