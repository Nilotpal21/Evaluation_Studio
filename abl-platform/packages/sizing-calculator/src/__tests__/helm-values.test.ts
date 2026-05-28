import { describe, it, expect } from 'vitest';
import { generateHelmValues } from '../generators/helm-values.js';
import { calculateTopology } from '../engine/calculator.js';
import type { Questionnaire } from '../schemas/questionnaire.schema.js';

function makeQuestionnaire(): Questionnaire {
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
  };
}

describe('generateHelmValues', () => {
  it('generates values for all components', () => {
    const topology = calculateTopology(makeQuestionnaire());
    const values = generateHelmValues(topology);

    expect(Object.keys(values)).toContain('app-services.yaml');
    expect(Object.keys(values)).toContain('mongodb-operator.yaml');
    expect(Object.keys(values)).toContain('redis-operator.yaml');
    expect(Object.keys(values)).toContain('clickhouse-operator.yaml');
    expect(Object.keys(values)).toContain('opensearch-operator.yaml');
    expect(Object.keys(values)).toContain('neo4j-operator.yaml');
    expect(Object.keys(values)).toContain('qdrant-operator.yaml');
    expect(Object.keys(values)).toContain('restate-operator.yaml');
    expect(Object.keys(values)).toContain('node-pools.yaml');
  });

  it('generates valid YAML-like content for app services', () => {
    const topology = calculateTopology(makeQuestionnaire());
    const values = generateHelmValues(topology);
    const appValues = values['app-services.yaml'];

    expect(appValues).toContain('runtime:');
    expect(appValues).toContain('replicas:');
    expect(appValues).toContain('resources:');
    expect(appValues).toContain('cpu:');
    expect(appValues).toContain('memory:');
  });

  it('MongoDB values contain replica set config', () => {
    const topology = calculateTopology(makeQuestionnaire());
    const values = generateHelmValues(topology);
    const mongoValues = values['mongodb-operator.yaml'];

    expect(mongoValues).toContain('psmdb:');
    expect(mongoValues).toContain('replsets:');
    expect(mongoValues).toContain('backup:');
  });

  it('Redis values contain noeviction policy', () => {
    const topology = calculateTopology(makeQuestionnaire());
    const values = generateHelmValues(topology);
    const redisValues = values['redis-operator.yaml'];

    expect(redisValues).toContain('noeviction');
  });

  it('node pools contain instance types', () => {
    const topology = calculateTopology(makeQuestionnaire());
    const values = generateHelmValues(topology);
    const poolValues = values['node-pools.yaml'];

    expect(poolValues).toContain('instanceType:');
    expect(poolValues).toContain('minSize:');
    expect(poolValues).toContain('maxSize:');
  });

  it('includes tier in comments', () => {
    const topology = calculateTopology(makeQuestionnaire());
    const values = generateHelmValues(topology);

    for (const content of Object.values(values)) {
      expect(content).toContain('Tier: S');
    }
  });
});
