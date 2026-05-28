import { describe, it, expect } from 'vitest';
import {
  calculateDiskGrowth,
  calculateMongoGrowth,
  calculateOpensearchGrowth,
  calculateRestateGrowth,
  calculateRedisGrowth,
} from '../engine/disk-growth.js';
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
      messagesPerDay: 10000,
      toolCallsPerConversation: 3,
      multiAgentUsage: 0,
    },
    knowledgeBase: {
      totalDocuments: 100000,
      avgDocumentSize: 'medium',
      documentTypes: ['pdf'],
      ingestionFrequency: 'daily',
      connectorTypes: ['file-upload'],
      kbPerProject: 1,
      vectorSearchQueriesPerDay: 500,
    },
    workflows: {
      activeWorkflows: 10,
      executionsPerDay: 1000,
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

describe('DiskGrowthCalculator', () => {
  it('returns projections for all 7 stores', () => {
    const q = makeQuestionnaire();
    const projections = calculateDiskGrowth(q);
    expect(projections).toHaveLength(7);
    const names = projections.map((p) => p.storeName);
    expect(names).toContain('mongodb');
    expect(names).toContain('clickhouse');
    expect(names).toContain('opensearch');
    expect(names).toContain('neo4j');
    expect(names).toContain('qdrant');
    expect(names).toContain('restate');
    expect(names).toContain('redis');
  });

  it('calculates MongoDB growth', () => {
    const q = makeQuestionnaire();
    const growth = calculateMongoGrowth(q);
    expect(growth.monthlyGB).toBeGreaterThan(0);
    expect(growth.yearlyGB).toBeCloseTo(growth.monthlyGB * 12, 0);
    expect(growth.drivers).toContain('messages');
  });

  it('calculates OpenSearch growth with vector embeddings', () => {
    const q = makeQuestionnaire();
    const growth = calculateOpensearchGrowth(q);
    expect(growth.monthlyGB).toBeGreaterThan(0);
    expect(growth.drivers).toContain('vector-embeddings');
    expect(growth.drivers).toContain('document-chunks');
  });

  it('calculates Restate growth based on workflow volume', () => {
    const q = makeQuestionnaire();
    const growth = calculateRestateGrowth(q);
    // 1000 executions/day × 5 steps × 30 days × 1KB = ~150MB
    expect(growth.monthlyGB).toBeGreaterThan(0);
    expect(growth.drivers).toContain('journal-entries');
  });

  it('Redis growth is minimal (TTL-bounded)', () => {
    const q = makeQuestionnaire();
    const growth = calculateRedisGrowth(q);
    // Redis is ephemeral — yearly = monthly (bounded)
    expect(growth.yearlyGB).toBe(growth.monthlyGB);
  });

  it('scales with message volume', () => {
    const lowVolume = makeQuestionnaire({
      agents: { ...makeQuestionnaire().agents, messagesPerDay: 1000 },
    });
    const highVolume = makeQuestionnaire({
      agents: { ...makeQuestionnaire().agents, messagesPerDay: 100000 },
    });

    const lowGrowth = calculateMongoGrowth(lowVolume);
    const highGrowth = calculateMongoGrowth(highVolume);

    expect(highGrowth.monthlyGB).toBeGreaterThan(lowGrowth.monthlyGB);
  });

  it('projections have positive yearlyGB', () => {
    const q = makeQuestionnaire();
    const projections = calculateDiskGrowth(q);
    for (const p of projections) {
      expect(p.yearlyGB).toBeGreaterThanOrEqual(0);
    }
  });
});
