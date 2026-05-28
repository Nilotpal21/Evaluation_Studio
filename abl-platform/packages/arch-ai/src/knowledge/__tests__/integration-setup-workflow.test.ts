import { describe, expect, it } from 'vitest';
import { selectKnowledgeCards } from '../card-router.js';

describe('integration-setup-workflow card', () => {
  it('loads when user mentions "set up integration"', () => {
    const result = selectKnowledgeCards(
      'I want to set up an integration with Slack',
      undefined,
      [],
    );
    expect(result.selectedIds).toContain('integration-setup-workflow');
  });

  it('loads when user says "hook up <provider>"', () => {
    const result = selectKnowledgeCards('hook up Salesforce please', undefined, []);
    expect(result.selectedIds).toContain('integration-setup-workflow');
  });

  it('loads when user mentions OAuth or api key', () => {
    const result = selectKnowledgeCards('I need to add an api key for our backend', undefined, []);
    expect(result.selectedIds).toContain('integration-setup-workflow');
  });

  it('does NOT load on unrelated messages', () => {
    const result = selectKnowledgeCards('rename my supervisor agent', undefined, []);
    expect(result.selectedIds).not.toContain('integration-setup-workflow');
  });
});
