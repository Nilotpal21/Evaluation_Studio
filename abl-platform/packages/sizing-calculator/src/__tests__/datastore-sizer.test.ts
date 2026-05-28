import { describe, it, expect } from 'vitest';
import { sizeDataStores } from '../engine/datastore-sizer.js';
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

describe('sizeDataStores', () => {
  it('returns all 7 data stores', () => {
    const q = makeQuestionnaire();
    const stores = sizeDataStores('S', q);
    expect(stores).toHaveLength(7);
    const names = stores.map((s) => s.name);
    expect(names).toContain('mongodb');
    expect(names).toContain('redis');
    expect(names).toContain('clickhouse');
    expect(names).toContain('opensearch');
    expect(names).toContain('neo4j');
    expect(names).toContain('qdrant');
    expect(names).toContain('restate');
  });

  it('MongoDB tier S has 3 replicas, no sharding', () => {
    const q = makeQuestionnaire();
    const stores = sizeDataStores('S', q);
    const mongo = stores.find((s) => s.name === 'mongodb')!;
    expect(mongo.replicas).toBe(3);
    expect(mongo.shardCount).toBe(1);
    expect(mongo.replicationFactor).toBe(3);
    expect(mongo.partitionStrategy).toBe('none');
  });

  it('MongoDB tier L has sharding enabled', () => {
    const q = makeQuestionnaire();
    const stores = sizeDataStores('L', q);
    const mongo = stores.find((s) => s.name === 'mongodb')!;
    expect(mongo.shardCount).toBe(3);
    expect(mongo.replicas).toBe(9);
    expect(mongo.partitionStrategy).toBe('tenantId-based');
  });

  it('Redis tier M has cluster mode', () => {
    const q = makeQuestionnaire();
    const stores = sizeDataStores('M', q);
    const redis = stores.find((s) => s.name === 'redis')!;
    expect(redis.replicas).toBe(6);
    expect(redis.shardCount).toBe(3);
    expect(redis.partitionStrategy).toBe('cluster-hash-slots');
  });

  it('ClickHouse includes Keeper nodes in replica count', () => {
    const q = makeQuestionnaire();
    const stores = sizeDataStores('S', q);
    const ch = stores.find((s) => s.name === 'clickhouse')!;
    expect(ch.replicas).toBe(4); // 1 data + 3 keeper
  });

  it('data stores have TTL policies based on retention settings', () => {
    const q = makeQuestionnaire();
    const stores = sizeDataStores('M', q);
    const mongo = stores.find((s) => s.name === 'mongodb')!;
    expect(mongo.ttlPolicies).toBeDefined();
    expect(mongo.ttlPolicies!.length).toBeGreaterThan(0);

    const messagesTtl = mongo.ttlPolicies!.find((p) => p.collection === 'messages');
    expect(messagesTtl).toBeDefined();
    expect(messagesTtl!.ttlDays).toBe(90); // from conversationRetention: '90d'
  });

  it('backup config uses s3 for AWS', () => {
    const q = makeQuestionnaire();
    const stores = sizeDataStores('S', q);
    const mongo = stores.find((s) => s.name === 'mongodb')!;
    expect(mongo.backupConfig.destination).toBe('s3');
  });

  it('Restate tier L has 5 replicas with 16 partitions', () => {
    const q = makeQuestionnaire();
    const stores = sizeDataStores('L', q);
    const restate = stores.find((s) => s.name === 'restate')!;
    expect(restate.replicas).toBe(5);
    expect(restate.shardCount).toBe(16);
    expect(restate.replicationFactor).toBe(5);
  });
});
