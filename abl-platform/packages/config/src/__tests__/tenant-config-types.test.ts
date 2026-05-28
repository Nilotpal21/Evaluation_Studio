/**
 * Tenant Config Types — Type-level tests
 *
 * Verifies that shared interfaces satisfy expected shapes and that
 * both runtime and studio can import them without conflicts.
 */

import { describe, it, expect } from 'vitest';
import type {
  Plan,
  TenantLimits,
  TenantFeatures,
  TenantSecurityConfig,
  TenantConfig,
} from '../tenant-config-types.js';

describe('Tenant Config Types', () => {
  it('Plan type accepts all four plan tiers', () => {
    const plans: Plan[] = ['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE'];
    expect(plans).toHaveLength(4);
  });

  it('TenantLimits includes messageRetentionDays', () => {
    const limits: TenantLimits = {
      maxConcurrentSessions: 5,
      maxServiceTimeoutMs: 10_000,
      maxResponseBodyBytes: 524_288,
      maxConcurrentServiceCalls: 3,
      maxPendingTimers: 100,
      maxAgentsPerProject: 3,
      maxEventTypesPerApp: 10,
      maxProjectsPerOrg: 3,
      requestsPerMinute: 60,
      tokensPerMinute: 50_000,
      toolCallsPerMinute: 50,
      messagesPerMonth: 1_000,
      traceRetentionDays: 7,
      sessionRetentionDays: 7,
      auditLogRetentionDays: 30,
      messageRetentionDays: 30,
    };
    expect(limits.messageRetentionDays).toBe(30);
  });

  it('TenantFeatures includes both advancedNlu and archiveEnabled', () => {
    const features: TenantFeatures = {
      customModels: false,
      ssoEnabled: false,
      mfaEnabled: false,
      auditLogExport: false,
      dataResidency: false,
      customDomains: false,
      prioritySupport: false,
      advancedAnalytics: false,
      advancedNlu: false,
      archiveEnabled: false,
    };
    expect(features.advancedNlu).toBe(false);
    expect(features.archiveEnabled).toBe(false);
  });

  it('TenantSecurityConfig includes sessionIdleSeconds and scrubPII', () => {
    const security: TenantSecurityConfig = {
      allowedServiceDomains: ['*'],
      requireMtls: false,
      ipAllowlist: [],
      requireMfa: false,
      sessionMaxAgeSeconds: 3_600,
      sessionIdleSeconds: 600,
      apiKeyMaxAgeDays: 90,
      scrubPII: false,
    };
    expect(security.sessionIdleSeconds).toBe(600);
    expect(security.scrubPII).toBe(false);
  });

  it('TenantConfig composes all sub-interfaces', () => {
    const config: TenantConfig = {
      tenantId: 'test-tenant',
      plan: 'FREE',
      limits: {
        maxConcurrentSessions: 5,
        maxServiceTimeoutMs: 10_000,
        maxResponseBodyBytes: 524_288,
        maxConcurrentServiceCalls: 3,
        maxPendingTimers: 100,
        maxAgentsPerProject: 3,
        maxEventTypesPerApp: 10,
        maxProjectsPerOrg: 3,
        requestsPerMinute: 60,
        tokensPerMinute: 50_000,
        toolCallsPerMinute: 50,
        messagesPerMonth: 1_000,
        traceRetentionDays: 7,
        sessionRetentionDays: 7,
        auditLogRetentionDays: 30,
        messageRetentionDays: 30,
      },
      features: {
        customModels: false,
        ssoEnabled: false,
        mfaEnabled: false,
        auditLogExport: false,
        dataResidency: false,
        customDomains: false,
        prioritySupport: false,
        advancedAnalytics: false,
        advancedNlu: false,
        archiveEnabled: false,
      },
      security: {
        allowedServiceDomains: ['*'],
        requireMtls: false,
        ipAllowlist: [],
        requireMfa: false,
        sessionMaxAgeSeconds: 3_600,
        sessionIdleSeconds: 600,
        apiKeyMaxAgeDays: 90,
        scrubPII: false,
      },
    };
    expect(config.tenantId).toBe('test-tenant');
    expect(config.plan).toBe('FREE');
  });
});
