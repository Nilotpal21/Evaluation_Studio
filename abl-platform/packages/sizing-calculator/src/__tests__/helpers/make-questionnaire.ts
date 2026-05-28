import type { Questionnaire } from '../../schemas/questionnaire.schema.js';

/**
 * Shared test factory for Questionnaire objects.
 * Provides sensible defaults for a tier-M deployment.
 */
export function makeQ(overrides: Partial<Questionnaire> = {}): Questionnaire {
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
      concurrentConversations: 500,
      avgConversationLength: 10,
      messagesPerDay: 10000,
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
      vectorSearchQueriesPerDay: 5000,
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
