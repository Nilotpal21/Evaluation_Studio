import { describe, it, expect } from 'vitest';
import { sizeApplicationServices } from '../engine/service-sizer.js';
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

describe('sizeApplicationServices', () => {
  it('produces all Tier S services', () => {
    const q = makeQuestionnaire();
    const services = sizeApplicationServices('S', q);

    expect(services.length).toBeGreaterThanOrEqual(10);

    const runtime = services.find((s) => s.name === 'runtime');
    expect(runtime).toBeDefined();
    expect(runtime!.replicas).toBe(2);
    expect(runtime!.resources.cpu).toBe('1');
    expect(runtime!.resources.memory).toBe('2Gi');
  });

  it('produces M tier with HPA configs', () => {
    const q = makeQuestionnaire();
    const services = sizeApplicationServices('M', q);

    const runtime = services.find((s) => s.name === 'runtime');
    expect(runtime).toBeDefined();
    expect(runtime!.replicas).toBe(3);
    expect(runtime!.hpa).toBeDefined();
    expect(runtime!.hpa!.maxReplicas).toBe(6);
  });

  it('scales runtime replicas for high concurrent conversations', () => {
    const q = makeQuestionnaire({
      agents: {
        agentCount: 50,
        concurrentConversations: 20000,
        avgConversationLength: 10,
        messagesPerDay: 50000,
        toolCallsPerConversation: 3,
        multiAgentUsage: 0,
      },
    });
    const services = sizeApplicationServices('M', q);
    const runtime = services.find((s) => s.name === 'runtime');
    // 20000/5000 = 4x factor, capped at 3x → ceil(3*3) = 9
    expect(runtime!.replicas).toBeGreaterThan(3);
  });

  it('scales search-ai for high document counts', () => {
    const q = makeQuestionnaire({
      knowledgeBase: {
        totalDocuments: 500000,
        avgDocumentSize: 'medium',
        documentTypes: ['pdf'],
        ingestionFrequency: 'daily',
        connectorTypes: ['file-upload'],
        kbPerProject: 5,
        vectorSearchQueriesPerDay: 100000,
      },
    });
    const services = sizeApplicationServices('M', q);
    const searchAi = services.find((s) => s.name === 'search-ai');
    expect(searchAi!.replicas).toBeGreaterThan(2);
  });

  it('includes all expected service names', () => {
    const q = makeQuestionnaire();
    const services = sizeApplicationServices('L', q);
    const names = services.map((s) => s.name);

    expect(names).toContain('runtime');
    expect(names).toContain('studio');
    expect(names).toContain('admin');
    expect(names).toContain('search-ai');
    expect(names).toContain('search-ai-runtime');
    expect(names).toContain('workflow-engine');
    expect(names).toContain('preprocessing');
    expect(names).toContain('multimodal');
  });
});
