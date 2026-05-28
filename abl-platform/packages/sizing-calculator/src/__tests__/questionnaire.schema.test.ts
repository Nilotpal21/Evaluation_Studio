import { describe, it, expect } from 'vitest';
import { QuestionnaireSchema } from '../schemas/questionnaire.schema.js';

const validQuestionnaire = {
  deployment: {
    cloudProvider: 'aws',
    regionCount: 1,
    haRequirement: 'standard',
    networkIsolation: 'shared-vpc',
    compliance: [],
  },
  llm: {
    hostingModel: 'external-api',
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

describe('QuestionnaireSchema', () => {
  it('validates a complete starter-tier questionnaire', () => {
    const result = QuestionnaireSchema.safeParse(validQuestionnaire);
    expect(result.success).toBe(true);
  });

  it('rejects invalid cloud provider', () => {
    const input = {
      ...validQuestionnaire,
      deployment: { ...validQuestionnaire.deployment, cloudProvider: 'oracle' },
    };
    const result = QuestionnaireSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects negative region count', () => {
    const input = {
      ...validQuestionnaire,
      deployment: { ...validQuestionnaire.deployment, regionCount: 0 },
    };
    const result = QuestionnaireSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects concurrent conversations below minimum', () => {
    const input = {
      ...validQuestionnaire,
      agents: { ...validQuestionnaire.agents, concurrentConversations: 5 },
    };
    const result = QuestionnaireSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('validates enterprise-tier questionnaire with all features', () => {
    const enterprise = {
      ...validQuestionnaire,
      deployment: {
        cloudProvider: 'aws',
        regionCount: 3,
        haRequirement: 'maximum',
        networkIsolation: 'dedicated-vpc',
        compliance: ['soc2', 'hipaa', 'gdpr'],
      },
      llm: {
        hostingModel: 'hybrid',
        selfHostedModels: ['llama-3.1-70b'],
        concurrentRequests: 5000,
        contextWindow: 'large',
        embeddingModel: 'bge-m3',
      },
      agents: {
        agentCount: 500,
        concurrentConversations: 50000,
        avgConversationLength: 20,
        messagesPerDay: 200000,
        toolCallsPerConversation: 10,
        multiAgentUsage: 60,
      },
      knowledgeBase: {
        totalDocuments: 2000000,
        avgDocumentSize: 'large',
        documentTypes: ['pdf', 'word', 'html', 'spreadsheet'],
        ingestionFrequency: 'hourly',
        connectorTypes: ['web-crawl', 'sharepoint', 'api', 'file-upload'],
        kbPerProject: 10,
        vectorSearchQueriesPerDay: 500000,
      },
    };
    const result = QuestionnaireSchema.safeParse(enterprise);
    expect(result.success).toBe(true);
  });

  it('defaults selfHostedModels to empty array when not provided', () => {
    const result = QuestionnaireSchema.safeParse(validQuestionnaire);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.llm.selfHostedModels).toEqual([]);
    }
  });

  it('rejects missing required sections', () => {
    const result = QuestionnaireSchema.safeParse({ deployment: validQuestionnaire.deployment });
    expect(result.success).toBe(false);
  });
});
