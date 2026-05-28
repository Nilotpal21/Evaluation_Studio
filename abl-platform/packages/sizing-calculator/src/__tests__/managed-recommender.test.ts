import { describe, it, expect } from 'vitest';
import { recommendManagedServices } from '../engine/managed-recommender.js';
import type { Questionnaire } from '../schemas/questionnaire.schema.js';

function makeQuestionnaire(overrides: Partial<Questionnaire> = {}): Questionnaire {
  return {
    deployment: {
      cloudProvider: 'aws',
      regionCount: 1,
      haRequirement: 'standard',
      networkIsolation: 'shared-vpc',
      compliance: [],
    },
    llm: {
      hostingModel: 'external-api',
      selfHostedModels: [],
      concurrentRequests: 50,
      contextWindow: 'medium',
      embeddingModel: 'bge-m3',
    },
    agents: {
      agentCount: 5,
      concurrentConversations: 100,
      avgConversationLength: 10,
      messagesPerDay: 1000,
      toolCallsPerConversation: 3,
      multiAgentUsage: 0,
    },
    knowledgeBase: {
      totalDocuments: 1000,
      avgDocumentSize: 'small',
      documentTypes: ['pdf'],
      ingestionFrequency: 'daily',
      connectorTypes: ['file-upload'],
      kbPerProject: 1,
      vectorSearchQueriesPerDay: 500,
    },
    workflows: {
      activeWorkflows: 10,
      executionsPerDay: 100,
      avgStepsPerWorkflow: 5,
      triggers: ['manual'],
      externalApiCallsPerWorkflow: 2,
    },
    channels: {
      activeChannels: ['web-widget'],
      voiceVideoUsage: 0,
      inboundWebhooksPerDay: 0,
      outboundWebhooksPerDay: 0,
    },
    observability: {
      adminUsers: 5,
      traceRetention: '30d',
      metricsRetention: '90d',
      auditLogRetention: '1y',
      monitoringStack: 'platform-builtin',
    },
    retention: {
      conversationRetention: '90d',
      documentRetention: 'until-deleted',
      attachmentRetention: '1y',
      encryptionAtRest: 'platform-aes256',
      backupFrequency: 'daily',
      drRtpRpo: 'rpo-24h-rto-4h',
    },
    ...overrides,
  };
}

describe('recommendManagedServices', () => {
  it('returns recommendations for all 7 stores', () => {
    const q = makeQuestionnaire();
    const recs = recommendManagedServices('M', q);
    expect(recs).toHaveLength(7);
  });

  it('air-gapped always recommends self-hosted', () => {
    const q = makeQuestionnaire({
      deployment: {
        cloudProvider: 'aws',
        regionCount: 1,
        haRequirement: 'standard',
        networkIsolation: 'air-gapped',
        compliance: [],
      },
    });
    const recs = recommendManagedServices('L', q);
    for (const rec of recs) {
      expect(rec.recommendation).toBe('self-hosted');
    }
  });

  it('Restate always self-hosted', () => {
    const q = makeQuestionnaire();
    const recs = recommendManagedServices('XL', q);
    const restate = recs.find((r) => r.storeName === 'restate');
    expect(restate!.recommendation).toBe('self-hosted');
    expect(restate!.reason).toContain('No managed offering');
  });

  it('tier S prefers self-hosted for cost', () => {
    const q = makeQuestionnaire();
    const recs = recommendManagedServices('S', q);
    const mongo = recs.find((r) => r.storeName === 'mongodb');
    expect(mongo!.recommendation).toBe('self-hosted');
  });

  it('tier L on AWS recommends managed MongoDB Atlas', () => {
    const q = makeQuestionnaire();
    const recs = recommendManagedServices('L', q);
    const mongo = recs.find((r) => r.storeName === 'mongodb');
    expect(mongo!.recommendation).toBe('managed');
    expect(mongo!.managedService).toContain('Atlas');
  });

  it('tier M on AWS recommends ElastiCache for Redis', () => {
    const q = makeQuestionnaire();
    const recs = recommendManagedServices('M', q);
    const redis = recs.find((r) => r.storeName === 'redis');
    expect(redis!.recommendation).toBe('managed');
    expect(redis!.managedService).toContain('ElastiCache');
  });
});
