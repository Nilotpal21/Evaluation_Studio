import { describe, expect, it } from 'vitest';
import { selectKnowledgeCards } from '../card-router.js';

describe('oauth-flow-primer card', () => {
  it('loads when user mentions "oauth"', () => {
    const result = selectKnowledgeCards('How does OAuth work for our integrations?', undefined, []);
    expect(result.selectedIds).toContain('oauth-flow-primer');
  });

  it('loads when user mentions "consent"', () => {
    const result = selectKnowledgeCards(
      'The user needs to give consent before we can call the API',
      undefined,
      [],
    );
    expect(result.selectedIds).toContain('oauth-flow-primer');
  });

  it('does NOT load on unrelated messages', () => {
    const result = selectKnowledgeCards('rename my supervisor agent', undefined, []);
    expect(result.selectedIds).not.toContain('oauth-flow-primer');
  });
});
