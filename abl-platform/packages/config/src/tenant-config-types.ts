/**
 * Shared Tenant Configuration Types
 *
 * Pure type definitions for tenant config — no runtime dependencies.
 * Imported by both runtime (full service logic) and studio (types only).
 *
 * Plans: FREE → TEAM → BUSINESS → ENTERPRISE
 */

export type Plan = 'FREE' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE';

export interface TenantLimits {
  maxConcurrentSessions: number; // -1 = unlimited
  maxServiceTimeoutMs: number;
  maxResponseBodyBytes: number;
  maxConcurrentServiceCalls: number;
  maxPendingTimers: number;
  maxAgentsPerProject: number;
  maxEventTypesPerApp: number;
  maxProjectsPerOrg: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  toolCallsPerMinute: number; // -1 = unlimited
  messagesPerMonth: number; // -1 = unlimited
  traceRetentionDays: number;
  sessionRetentionDays: number;
  auditLogRetentionDays: number;
  messageRetentionDays: number; // Days before messages auto-expire via TTL index
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
  advancedNlu: boolean;
  archiveEnabled: boolean;
  codeToolsEnabled: boolean;
}

export interface TenantSecurityConfig {
  allowedServiceDomains: string[];
  requireMtls: boolean;
  ipAllowlist: string[];
  requireMfa: boolean;
  sessionMaxAgeSeconds: number;
  sessionIdleSeconds: number; // Inactivity timeout — Redis key expires after this many idle seconds
  apiKeyMaxAgeDays: number;
  scrubPII: boolean; // When true, PII is scrubbed from traces and analytics
}

export interface TenantEvalRetentionConfig {
  evalConversationsTtlDays?: number;
  evalScoresTtlDays?: number;
  productionScoresTtlDays?: number;
  syntheticTtlDays?: number;
  hardDeleteExpiredRuns?: boolean;
  scrubPiiOnStore?: boolean;
}

export interface TenantConfig {
  tenantId: string;
  plan: Plan;
  limits: TenantLimits;
  features: TenantFeatures;
  security: TenantSecurityConfig;
  evalRetention?: TenantEvalRetentionConfig;
}
