import { z } from 'zod';

// =============================================================================
// Section A: Deployment & Infrastructure
// =============================================================================

const DeploymentSchema = z.object({
  cloudProvider: z.enum(['aws', 'azure', 'gcp', 'on-prem']),
  regionCount: z.number().int().min(1).max(5),
  haRequirement: z.enum(['standard', 'high', 'maximum']),
  networkIsolation: z.enum(['shared-vpc', 'dedicated-vpc', 'air-gapped']),
  compliance: z.array(z.enum(['soc2', 'hipaa', 'pci-dss', 'gdpr', 'fedramp', 'none'])),
});

// =============================================================================
// Section B: LLM & AI Configuration
// =============================================================================

const LlmSchema = z.object({
  hostingModel: z.enum(['external-api', 'self-hosted', 'hybrid']),
  selfHostedModels: z
    .array(
      z.enum(['llama-3.1-8b', 'llama-3.1-70b', 'llama-3.1-405b', 'mistral', 'mixtral', 'custom']),
    )
    .optional()
    .default([]),
  concurrentRequests: z.number().int().min(10).max(10000),
  contextWindow: z.enum(['small', 'medium', 'large', 'xl']),
  embeddingModel: z.enum(['bge-m3', 'external-api', 'custom']),
});

// =============================================================================
// Section C: Agent & Conversation Volume
// =============================================================================

const AgentsSchema = z.object({
  agentCount: z.number().int().min(1).max(10000),
  concurrentConversations: z.number().int().min(10).max(1000000),
  avgConversationLength: z.number().int().min(1).max(500),
  messagesPerDay: z.number().int().min(100).max(50000000),
  toolCallsPerConversation: z.number().int().min(0).max(50),
  multiAgentUsage: z.number().min(0).max(100),
});

// =============================================================================
// Section D: Knowledge Base & Search
// =============================================================================

const KnowledgeBaseSchema = z.object({
  totalDocuments: z.number().int().min(0).max(50000000),
  avgDocumentSize: z.enum(['small', 'medium', 'large', 'xl']),
  documentTypes: z.array(z.enum(['pdf', 'word', 'html', 'spreadsheet', 'image', 'video'])),
  ingestionFrequency: z.enum(['one-time', 'daily', 'hourly', 'real-time']),
  connectorTypes: z.array(z.enum(['web-crawl', 'sharepoint', 'git', 'api', 'file-upload'])),
  kbPerProject: z.number().int().min(0).max(50),
  vectorSearchQueriesPerDay: z.number().int().min(0).max(10000000),
});

// =============================================================================
// Section E: Workflows & Automation
// =============================================================================

const WorkflowsSchema = z.object({
  activeWorkflows: z.number().int().min(0).max(10000),
  executionsPerDay: z.number().int().min(0).max(1000000),
  avgStepsPerWorkflow: z.number().int().min(2).max(50),
  triggers: z.array(z.enum(['scheduled', 'webhook', 'event-driven', 'manual'])),
  externalApiCallsPerWorkflow: z.number().int().min(0).max(20),
});

// =============================================================================
// Section F: Channels & Integrations
// =============================================================================

const ChannelsSchema = z.object({
  activeChannels: z.array(
    z.enum(['web-widget', 'slack', 'teams', 'whatsapp', 'voice', 'sms', 'email', 'custom']),
  ),
  voiceVideoUsage: z.number().min(0).max(100),
  inboundWebhooksPerDay: z.number().int().min(0).max(10000000),
  outboundWebhooksPerDay: z.number().int().min(0).max(10000000),
});

// =============================================================================
// Section G: Admin & Observability
// =============================================================================

const ObservabilitySchema = z.object({
  adminUsers: z.number().int().min(1).max(500),
  traceRetention: z.enum(['7d', '30d', '90d', '1y']),
  metricsRetention: z.enum(['30d', '90d', '1y', '2y']),
  auditLogRetention: z.enum(['1y', '3y', '7y']),
  monitoringStack: z.enum(['platform-builtin', 'prometheus-grafana', 'datadog', 'cloudwatch']),
});

// =============================================================================
// Section H: Retention & Storage Policy
// =============================================================================

const RetentionSchema = z.object({
  conversationRetention: z.enum(['30d', '90d', '1y', 'indefinite']),
  documentRetention: z.enum(['until-deleted', '1y', '3y']),
  attachmentRetention: z.enum(['30d', '90d', '1y']),
  encryptionAtRest: z.enum(['platform-aes256', 'customer-kms', 'none']),
  backupFrequency: z.enum(['continuous', 'hourly', 'daily']),
  drRtpRpo: z.enum(['rpo-1min-rto-15min', 'rpo-1hr-rto-1hr', 'rpo-24h-rto-4h']),
});

// =============================================================================
// Complete Questionnaire
// =============================================================================

export const QuestionnaireSchema = z.object({
  deployment: DeploymentSchema,
  llm: LlmSchema,
  agents: AgentsSchema,
  knowledgeBase: KnowledgeBaseSchema,
  workflows: WorkflowsSchema,
  channels: ChannelsSchema,
  observability: ObservabilitySchema,
  retention: RetentionSchema,
});

export type Questionnaire = z.infer<typeof QuestionnaireSchema>;
