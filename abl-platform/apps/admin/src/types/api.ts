import type { ServiceBuildInfo } from '@agent-platform/shared/build-info';

export interface ConfigResponse {
  environment: string;
  config: Record<string, Record<string, unknown>>;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'removed' | 'changed' | 'same';
  leftValue?: unknown;
  rightValue?: unknown;
  isSensitive: boolean;
}

export interface ConfigDiff {
  entries: DiffEntry[];
  hasCriticalDiffs: boolean;
  summary: {
    added: number;
    removed: number;
    changed: number;
    same: number;
  };
}

export interface SecretEntry {
  name: string;
  value: string;
  scope: string;
  environment: string;
}

export interface SecretsResponse {
  scope: string;
  environment: string;
  secrets: SecretEntry[];
}

export interface AuditEntry {
  timestamp: string;
  actor: string;
  actorRole: string;
  action: string;
  target: string;
  environment?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditResponse {
  entries: AuditEntry[];
  filters: Record<string, string | null>;
  limit: number;
  count: number;
}

export interface RotationEntry {
  secret: string;
  actor: string;
  timestamp: string;
  environment?: string;
  ipAddress?: string;
}

export interface RotationResponse {
  rotations: RotationEntry[];
}

export interface ApiError {
  error: string;
  details?: unknown;
}

export interface TenantSummary {
  _id: string;
  name: string;
  slug: string;
  status: string;
  organizationId: string | null;
  planTier: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TenantsResponse {
  success: boolean;
  tenants: TenantSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface TenantDetailResponse {
  success: boolean;
  tenant: TenantSummary & {
    ownerId: string;
    retentionDays: number;
    settings: Record<string, unknown> | null;
    llmPolicy: Record<string, unknown> | null;
  };
  subscription: {
    planTier: string;
    billingCycle: string;
    status: string;
  } | null;
  memberCount: number;
}

// ─── Tenant Members & Projects ────────────────────────────────────────────

export interface TenantMember {
  userId: string;
  email: string;
  name: string;
  role: string;
  joinedAt: string;
}

export interface TenantMembersResponse {
  success: boolean;
  members: TenantMember[];
  total: number;
}

export interface TenantProject {
  _id: string;
  name: string;
  slug: string;
  agentCount: number;
  createdAt: string;
}

export interface TenantProjectsResponse {
  success: boolean;
  projects: TenantProject[];
  total: number;
}

// ─── Config Overrides ──────────────────────────────────────────────────────

export interface TenantLimits {
  maxConcurrentSessions: number;
  maxServiceTimeoutMs: number;
  maxResponseBodyBytes: number;
  maxConcurrentServiceCalls: number;
  maxPendingTimers: number;
  maxAgentsPerProject: number;
  maxEventTypesPerApp: number;
  maxProjectsPerOrg: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  toolCallsPerMinute: number;
  messagesPerMonth: number;
  traceRetentionDays: number;
  sessionRetentionDays: number;
  auditLogRetentionDays: number;
  archiveRetentionDays: number;
}

export interface TenantFeatures {
  customModels: boolean;
  ssoEnabled: boolean;
  mfaEnabled: boolean;
  auditLogExport: boolean;
  dataResidency: boolean;
  customDomains: boolean;
  prioritySupport: boolean;
  advancedAnalytics: boolean;
  archiveEnabled: boolean;
}

export interface PlanDefaults {
  limits: TenantLimits;
  features: TenantFeatures;
}

export type PlanTier = 'FREE' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE';

export interface PlanDefaultsResponse {
  success: boolean;
  plans: Record<PlanTier, PlanDefaults>;
}

export interface TenantConfigResponse {
  success: boolean;
  config: {
    tenantId: string;
    plan: PlanTier;
    limits: TenantLimits;
    features: TenantFeatures;
    security: Record<string, unknown>;
  };
  planDefaults: PlanDefaults;
  overrides: Record<string, number>;
}

export interface SetOverridesResponse {
  success: boolean;
  config?: TenantConfigResponse['config'];
  overrides?: Record<string, number>;
  error?: string;
}

export interface ClearOverridesResponse {
  success: boolean;
  message?: string;
  error?: string;
}

// ─── System Health ────────────────────────────────────────────────────────

export type ServiceGroup = 'core-data' | 'agent-execution' | 'search-knowledge' | 'frontend';

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  latencyMs: number;
  lastCheck: string;
  id?: string;
  group?: ServiceGroup;
  port?: number;
  description?: string;
  configured?: boolean;
  dependsOn?: string[];
  build?: ServiceBuildInfo;
}

export interface SystemHealthResponse {
  success: boolean;
  services: ServiceHealth[];
  summary: {
    healthy: number;
    degraded: number;
    down: number;
    unknown?: number;
    total?: number;
    configured?: number;
  };
}

// ─── Billing Usage Reporting ──────────────────────────────────────────────

export type BillingUsageReportGranularity = 'hour' | 'day' | 'week' | 'month';

export interface BillingUsageReportMetrics {
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  durationSeconds: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  interactiveTurnCount: number;
  engagedSeconds: number;
  llmCallCount: number;
  toolCallCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface BillingUsageReportWindow extends BillingUsageReportMetrics {
  windowStart: string;
  windowEnd: string;
}

export interface BillingUsageTenantBreakdown extends BillingUsageReportMetrics {
  tenantId: string;
  tenantName: string;
}

export interface BillingUsageProjectBreakdown extends BillingUsageReportMetrics {
  projectId: string;
}

export interface BillingUsageChannelBreakdown extends BillingUsageReportMetrics {
  channel: string;
}

export interface UsageResponse {
  success: boolean;
  tenantId: string | null;
  projectId: string | null;
  granularity: BillingUsageReportGranularity;
  range: {
    windowStart: string;
    windowEnd: string;
    timeZone: 'UTC';
  };
  totals: BillingUsageReportMetrics;
  windows: BillingUsageReportWindow[];
  tenantBreakdown: BillingUsageTenantBreakdown[];
  projectBreakdown: BillingUsageProjectBreakdown[];
  channelBreakdown: BillingUsageChannelBreakdown[];
}

export interface BillingUsagePublicationVisibilityBatch {
  batchId: string;
  projectId: string | null;
  triggerSource: 'manual' | 'scheduled';
  materializationStatus: 'running' | 'completed' | 'failed';
  applicationStatus: 'recorded' | 'projected' | 'missing';
  publicationStatus: 'not_ready' | 'pending' | 'published' | 'superseded';
  publicationReason: string | null;
  resultCount: number;
  totalUnits: number;
  eventDispatchAttempted: boolean;
  startedAt: string;
  completedAt: string | null;
  publishedAt: string | null;
  applicationId: string | null;
}

export interface BillingUsagePublicationVisibilitySummary {
  completedBatchCount: number;
  runningBatchCount: number;
  failedBatchCount: number;
  pendingPublicationCount: number;
  publishedBatchCount: number;
  supersededBatchCount: number;
  lastMaterializedAt: string | null;
  lastPublishedAt: string | null;
}

export interface BillingUsagePublicationVisibilityResponse {
  success: boolean;
  visibility: {
    tenantId: string;
    projectId: string | null;
    summary: BillingUsagePublicationVisibilitySummary;
    batches: BillingUsagePublicationVisibilityBatch[];
  };
}

export interface BillingUsagePlatformPublicationVisibilityTenant extends BillingUsagePublicationVisibilitySummary {
  tenantId: string;
  tenantName: string | null;
}

export interface BillingUsagePlatformPublicationVisibilityResponse {
  success: boolean;
  visibility: {
    summary: BillingUsagePublicationVisibilitySummary;
    tenants: BillingUsagePlatformPublicationVisibilityTenant[];
  };
}

export interface BillingUsageMaterializationScope {
  basis: 'time_window' | 'completed_sessions';
  windowStart: string | null;
  windowEnd: string | null;
  endedBefore: string | null;
  completedSessionsCount: number | null;
  periodLabel: string | null;
}

export interface BillingUsageMaterializationSummaryBreakdown {
  projectId?: string;
  channel?: string;
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface BillingUsageMaterializationSummary {
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
  exclusionCounts: Record<string, number>;
  metricsSourceCounts: Record<string, number>;
  projectBreakdown: BillingUsageMaterializationSummaryBreakdown[];
  channelBreakdown: BillingUsageMaterializationSummaryBreakdown[];
}

export interface BillingUsageMaterializationDetailResponse {
  success: boolean;
  materialization: {
    batchId: string;
    tenantId: string;
    projectId: string | null;
    subscriptionId: string;
    status: 'running' | 'completed' | 'failed';
    triggerSource: 'manual' | 'scheduled';
    triggeredBy: string;
    request: {
      projectId: string | null;
      windowStart: string | null;
      windowEnd: string | null;
      endedBefore: string | null;
    };
    planTier: string;
    scope: BillingUsageMaterializationScope;
    summary: BillingUsageMaterializationSummary | null;
    warnings: string[];
    resultCount: number;
    eventDispatchAttempted: boolean;
    failureReason: string | null;
    startedAt: string;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
}

export interface BillingUsageMaterializationProjectionTarget {
  status: 'deferred' | 'applied';
  reason: string | null;
  targetId: string | null;
  targetIds: string[];
  appliedAt: string | null;
}

export interface BillingUsageMaterializationApplicationDetailResponse {
  success: boolean;
  application: {
    applicationId: string;
    tenantId: string;
    batchId: string;
    projectId: string | null;
    subscriptionId: string;
    status: 'recorded' | 'projected';
    triggerSource: 'manual' | 'scheduled';
    triggeredBy: string;
    appliedBy: string;
    materializationBasis: 'time_window' | 'completed_sessions';
    materializationScope: BillingUsageMaterializationScope;
    summarySnapshot: BillingUsageMaterializationSummary;
    warnings: string[];
    dealResolution: {
      organizationId: string;
      dealId: string;
      dealScope: 'organization' | 'project';
      matchType: 'project_exact' | 'organization_scope' | 'organization_fallback';
    };
    accountingPeriod: {
      billingCycle: string;
      billingStartDate: string;
      referenceAt: string;
      periodStart: string;
      periodEnd: string;
      periodLabel: string;
    };
    projection: {
      usageReports: BillingUsageMaterializationProjectionTarget;
      creditLedger: BillingUsageMaterializationProjectionTarget;
      billingLineItems: BillingUsageMaterializationProjectionTarget;
    };
    appliedAt: string;
    createdAt: string;
    updatedAt: string;
  };
}

export interface BillingUsageMaterializationResultPage {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface BillingUsageMaterializationSessionResult {
  sessionId: string;
  projectId: string;
  subscriptionId: string;
  batchId: string;
  sequence: number;
  triggerSource: 'manual' | 'scheduled';
  materializationBasis: 'time_window' | 'completed_sessions';
  channel: string;
  status: string;
  disposition: string | null;
  sessionType: string | null;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  interactiveTurnCount: number;
  engagedSeconds: number;
  llmCallCount: number;
  toolCallCount: number;
  metricsSource: 'clickhouse' | 'message_fallback';
  included: boolean;
  exclusionReasons: string[];
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
  createdAt: string;
  updatedAt: string;
}

export interface BillingUsageMaterializationResultsResponse {
  success: boolean;
  results: {
    batchId: string;
    page: BillingUsageMaterializationResultPage;
    sessions: BillingUsageMaterializationSessionResult[];
  };
}

// ─── Deals & Billing ────────────────────────────────────────────────────

interface DealLimitSet {
  maxConcurrentSessions: number;
  maxTokensPerMinute: number;
  maxRequestsPerMinute: number;
  maxStorageGB: number;
}

interface DealPhase {
  name: string;
  startDate: string;
  endDate: string;
  environments: {
    dev: DealLimitSet;
    staging: DealLimitSet;
    production: DealLimitSet;
  };
}

interface CreditAllotment {
  totalCredits: number;
  sharedPoolCredits: number;
  featureCredits: Record<string, number>;
  rolloverPolicy: 'none' | 'partial' | 'full';
  rolloverPercentage?: number;
}

export interface Deal {
  _id: string;
  organizationId: string;
  hubspotDealId?: string;
  name: string;
  status: 'active' | 'paused' | 'expired' | 'canceled';
  scope: 'organization' | 'project';
  projectId?: string;
  aggregationMode: 'additive' | 'max_wins' | 'dedicated';
  phases: DealPhase[];
  overagePolicy: 'hard_stop' | 'soft_cap' | 'auto_upgrade';
  overageAlertThresholds: number[];
  creditAllotment: CreditAllotment;
  features: string[];
  renewalDate?: string;
  contractEndDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DealDetailResponse {
  success: boolean;
  deal: Deal;
}

export interface DealsResponse {
  success: boolean;
  deals: Deal[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface CreditEntry {
  timestamp: string;
  feature: string;
  units: number;
  credits: number;
  source: 'usage' | 'topup' | 'adjustment' | 'rollover';
  projectId?: string;
  sessionId?: string;
  description?: string;
}

export interface CreditLedger {
  _id: string;
  dealId: string;
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  totalAllocated: number;
  totalConsumed: number;
  featureUsage: Record<string, number>;
  sharedPoolConsumed: number;
  entries: CreditEntry[];
}

export interface CreditLedgerResponse {
  success: boolean;
  ledger: CreditLedger;
}

export interface BillingLineItem {
  _id: string;
  dealId: string;
  periodLabel: string;
  description: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  category: 'base' | 'overage' | 'addon' | 'credit_topup';
  invoiced: boolean;
  invoiceId?: string;
  createdAt: string;
}

export interface BillingLineItemsResponse {
  success: boolean;
  lineItems: BillingLineItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ─── Tenant Usage ───────────────────────────────────────────────────────

export interface TenantUsageResponse {
  success: boolean;
  tenantId: string;
  projectId: string | null;
  granularity: BillingUsageReportGranularity;
  range: {
    windowStart: string;
    windowEnd: string;
    timeZone: 'UTC';
  };
  totals: BillingUsageReportMetrics;
  windows: BillingUsageReportWindow[];
  projectBreakdown: BillingUsageProjectBreakdown[];
  channelBreakdown: BillingUsageChannelBreakdown[];
}

// ─── Trace Search ────────────────────────────────────────────────────────

export interface TraceSummary {
  traceId: string;
  tenantId: string;
  tenantName: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  channel: string;
  startedAt: string;
  endedAt: string;
  totalDurationMs: number;
  eventCount: number;
  errorCount: number;
  eventTypes: string[];
}

export interface TraceSearchResponse {
  success: boolean;
  traces: TraceSummary[];
  pagination: { limit: number; offset: number; hasMore: boolean };
}

// ─── Trace Detail ────────────────────────────────────────────────────────

export interface TraceTimelineEvent {
  eventId: string;
  eventType: string;
  category: string;
  timestamp: string;
  spanId: string;
  parentSpanId: string;
  agentName: string;
  durationMs: number;
  hasError: boolean;
  errorType: string;
  channel: string;
  deploymentId: string;
  actorType: string;
}

export interface TraceDetail {
  traceId: string;
  tenantId: string;
  tenantName: string;
  projectId: string;
  sessionId: string;
  channel: string;
  startedAt: string;
  endedAt: string;
  totalDurationMs: number;
  totalEvents: number;
  hasErrors: boolean;
  errorCount: number;
}

export interface TraceDetailResponse {
  success: boolean;
  trace: TraceDetail;
  timeline: TraceTimelineEvent[];
}

// ─── Trace Performance ───────────────────────────────────────────────────

export interface STIPathEntry {
  stiPath: string;
  spanId: string;
  parentSpanId: string;
  agentName: string;
  configHash: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  hasError: boolean;
  errorType: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelId: string;
  provider: string;
  toolName: string;
  attributes: Record<string, unknown>;
}

export interface TracePerformanceResponse {
  success: boolean;
  paths: STIPathEntry[];
  totals: {
    totalDurationMs: number;
    totalTokens: number;
    totalPaths: number;
    errorPaths: number;
    modelBreakdown: Array<{ modelId: string; tokens: number; count: number }>;
  };
}

// ─── Trace Cost ──────────────────────────────────────────────────────────

export interface LLMCallEntry {
  modelId: string;
  provider: string;
  operationType: string;
  agentName: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  latencyMs: number;
  success: boolean;
  errorType: string;
  timestamp: string;
}

export interface TraceCostResponse {
  success: boolean;
  calls: LLMCallEntry[];
  totals: {
    totalCost: number;
    totalTokens: number;
    callCount: number;
    byModel: Array<{
      model: string;
      tokens: number;
      cost: number;
      count: number;
    }>;
  };
}

// ─── Session Summary ─────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  tenantId: string;
  tenantName: string;
  projectId: string;
  status: string;
  disposition: string;
  channel: string;
  currentAgent: string;
  agentVersion: string;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string;
  durationMs: number;
  messageCount: number;
  tokenCount: number;
  estimatedCost: number;
  errorCount: number;
  handoffCount: number;
  traceEventCount: number;
  identityTier: number;
  isTest: boolean;
}

export interface SessionSummaryResponse {
  success: boolean;
  summary: SessionSummary;
}

// ─── Feature Catalog & Tenant Features ───────────────────────────────────

export interface FeatureCatalogEntry {
  name: string;
  description: string;
  tier: string;
}

export interface FeatureCatalogResponse {
  success: boolean;
  catalog: Record<string, FeatureCatalogEntry>;
}

export interface TenantFeaturesResponse {
  success: boolean;
  tenantId: string;
  planTier: string;
  features: Record<string, boolean>;
}
