import { describe, it, expect } from 'vitest';
import { sizeComputeServices } from '../engine/compute-sizer.js';
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

describe('sizeComputeServices', () => {
  it('includes BGE-M3 when embedding model is bge-m3', () => {
    const q = makeQuestionnaire();
    const services = sizeComputeServices('S', q);
    const bge = services.find((s) => s.name === 'bge-m3');
    expect(bge).toBeDefined();
    expect(bge!.replicas).toBe(2);
    expect(bge!.nodePool).toBe('compute');
  });

  it('excludes BGE-M3 when using external embedding API', () => {
    const q = makeQuestionnaire({
      llm: {
        hostingModel: 'external-api',
        selfHostedModels: [],
        concurrentRequests: 50,
        contextWindow: 'medium',
        embeddingModel: 'external-api',
      },
    });
    const services = sizeComputeServices('S', q);
    const bge = services.find((s) => s.name === 'bge-m3');
    expect(bge).toBeUndefined();
  });

  it('includes self-hosted LLM when hosting model is self-hosted', () => {
    const q = makeQuestionnaire({
      llm: {
        hostingModel: 'self-hosted',
        selfHostedModels: ['llama-3.1-70b'],
        concurrentRequests: 200,
        contextWindow: 'large',
        embeddingModel: 'bge-m3',
      },
    });
    const services = sizeComputeServices('M', q);
    const llm = services.find((s) => s.name === 'self-hosted-llm-llama-3.1-70b');
    expect(llm).toBeDefined();
    expect(llm!.nodePool).toBe('gpu');
    expect(llm!.resources.gpu).toBe('1xA100-80GB');
  });

  it('excludes self-hosted LLM when using external API only', () => {
    const q = makeQuestionnaire();
    const services = sizeComputeServices('M', q);
    const llm = services.find((s) => s.name.startsWith('self-hosted-llm'));
    expect(llm).toBeUndefined();
  });

  it('always includes docling', () => {
    const q = makeQuestionnaire();
    const services = sizeComputeServices('S', q);
    const docling = services.find((s) => s.name === 'docling');
    expect(docling).toBeDefined();
    expect(docling!.replicas).toBe(1);
  });

  it('scales BGE-M3 with KEDA for real-time ingestion', () => {
    const q = makeQuestionnaire({
      knowledgeBase: {
        totalDocuments: 100000,
        avgDocumentSize: 'medium',
        documentTypes: ['pdf'],
        ingestionFrequency: 'real-time',
        connectorTypes: ['api'],
        kbPerProject: 5,
        vectorSearchQueriesPerDay: 100000,
      },
    });
    const services = sizeComputeServices('M', q);
    const bge = services.find((s) => s.name === 'bge-m3');
    expect(bge!.hpa?.kedaTriggers).toBeDefined();
    expect(bge!.hpa!.kedaTriggers!.length).toBeGreaterThan(0);
    expect(bge!.hpa!.kedaTriggers![0].type).toBe('redis');
  });

  it('scales self-hosted LLM with concurrent requests', () => {
    const q = makeQuestionnaire({
      llm: {
        hostingModel: 'self-hosted',
        selfHostedModels: ['llama-3.1-8b'],
        concurrentRequests: 1000,
        contextWindow: 'medium',
        embeddingModel: 'bge-m3',
      },
    });
    const services = sizeComputeServices('L', q);
    const llm = services.find((s) => s.name === 'self-hosted-llm-llama-3.1-8b');
    expect(llm).toBeDefined();
    expect(llm!.replicas).toBeGreaterThan(2);
  });
});
