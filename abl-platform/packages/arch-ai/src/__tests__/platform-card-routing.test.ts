import { describe, expect, it } from 'vitest';
import { selectKnowledgeCards } from '../knowledge/card-router.js';
import { composeSystemPrompt } from '../prompts/index.js';

describe('Platform card routing — page context', () => {
  it('loads deployment card when user is on deployments page', () => {
    const result = selectKnowledgeCards('what is this?', undefined, undefined, {
      area: 'project',
      page: 'deployments',
    });
    expect(result.selectedIds).toContain('deployments-lifecycle');
  });

  it('loads channels card when user is on deployments page', () => {
    const result = selectKnowledgeCards('how do I configure this?', undefined, undefined, {
      area: 'project',
      page: 'deployments',
    });
    expect(result.selectedIds).toContain('channels-overview');
  });

  it('loads kb-administration card when on search-ai page', () => {
    const result = selectKnowledgeCards('show me sources', undefined, undefined, {
      area: 'project',
      page: 'search-ai',
    });
    expect(result.selectedIds).toContain('kb-administration');
  });

  it('loads connections card on connections page', () => {
    const result = selectKnowledgeCards('help me', undefined, undefined, {
      area: 'project',
      page: 'connections',
    });
    expect(result.selectedIds).toContain('connections-integrations');
  });

  it('does not load page-context cards when on unrelated page', () => {
    const result = selectKnowledgeCards('what is this?', undefined, undefined, {
      area: 'project',
      page: 'agents',
    });
    expect(result.selectedIds).not.toContain('deployments-lifecycle');
    expect(result.selectedIds).not.toContain('channels-overview');
    expect(result.selectedIds).not.toContain('kb-administration');
  });
});

describe('Platform card routing — keyword matching', () => {
  it('loads runtime construct decision card for build semantics', () => {
    const result = selectKnowledgeCards(
      'When should the agent use ON_RESULT vs ON_SUCCESS, set variables after a tool, and pass context to child agents?',
    );
    expect(result.selectedIds).toContain('runtime-construct-decision');
  });

  it('loads channels-messaging card on Slack keyword', () => {
    const result = selectKnowledgeCards('how do I set up Slack?');
    expect(result.selectedIds).toContain('channels-messaging');
  });

  it('loads auth-profiles card on OAuth keyword', () => {
    const result = selectKnowledgeCards('I need to configure oauth for my tool');
    expect(result.selectedIds).toContain('auth-profiles');
  });

  it('loads deployments-lifecycle card on promote keyword', () => {
    const result = selectKnowledgeCards('how do I promote to production?');
    expect(result.selectedIds).toContain('deployments-lifecycle');
  });

  it('loads kb-administration card on knowledge base keyword', () => {
    const result = selectKnowledgeCards('create a knowledge base');
    expect(result.selectedIds).toContain('kb-administration');
  });

  it('loads kb tool sequences and operational guide together on upload workflow', () => {
    const result = selectKnowledgeCards('upload a file to the kb and check ingestion status');
    expect(result.selectedIds).toContain('kb-tool-sequences');
    expect(result.selectedIds).toContain('kb-operations');
  });

  it('loads external-agents-a2a card on a2a keyword', () => {
    const result = selectKnowledgeCards('register an a2a external agent');
    expect(result.selectedIds).toContain('external-agents-a2a');
  });
});

describe('Platform card routing — phase defaults', () => {
  it('injects runtime construct decisioning during blueprint and build phases', () => {
    const blueprintPrompt = composeSystemPrompt('multi-agent-architect', 'BLUEPRINT');
    const buildPrompt = composeSystemPrompt('abl-construct-expert', 'BUILD');

    expect(blueprintPrompt).toContain('## Runtime Construct Decision Card');
    expect(buildPrompt).toContain('## Runtime Construct Decision Card');
  });
});

describe('Platform card routing — expertise pairing', () => {
  it('co-loads channels-operations when channels-messaging is selected', () => {
    const result = selectKnowledgeCards('set up WhatsApp for my project');
    expect(result.selectedIds).toContain('channels-messaging');
    expect(result.selectedIds).toContain('channels-operations');
  });

  it('co-loads deployment-operations when deployments-lifecycle is selected', () => {
    const result = selectKnowledgeCards('I want to deploy to staging');
    expect(result.selectedIds).toContain('deployments-lifecycle');
    expect(result.selectedIds).toContain('deployment-operations');
  });

  it('co-loads auth-operations when auth-profiles is selected', () => {
    const result = selectKnowledgeCards('create an oauth auth profile');
    expect(result.selectedIds).toContain('auth-profiles');
    expect(result.selectedIds).toContain('auth-operations');
  });

  it('co-loads kb-operations when kb-administration is selected', () => {
    const result = selectKnowledgeCards('manage my knowledge base sources');
    expect(result.selectedIds).toContain('kb-administration');
    expect(result.selectedIds).toContain('kb-operations');
  });

  it('co-loads connection-operations when connections-integrations is selected', () => {
    const result = selectKnowledgeCards('set up a salesforce connection');
    expect(result.selectedIds).toContain('connections-integrations');
    expect(result.selectedIds).toContain('connection-operations');
  });
});
