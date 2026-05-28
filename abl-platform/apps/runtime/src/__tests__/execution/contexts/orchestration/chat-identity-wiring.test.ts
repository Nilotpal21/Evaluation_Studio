/**
 * Chat Identity Wiring Tests
 *
 * Validates that CallerContext is correctly built from TenantContextData
 * in the HTTP chat route, covering all three auth flows:
 * - SDK session token with identityTier=2 (HMAC-verified user)
 * - SDK session token with identityTier=0 (anonymous)
 * - User JWT (identityTier defaults to 0, initiatedById set)
 * - SDK session token with channelArtifact (pre-hashed artifact carried through)
 */

import { describe, it, expect } from 'vitest';
import { buildCallerContextFromTenantContext } from '../../../../services/identity/artifact-hasher.js';
import type { TenantContextData } from '@agent-platform/shared/types';

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT_ID = 'tenant-test-001';

function sdkTenantContext(overrides: Partial<TenantContextData> = {}): TenantContextData {
  return {
    tenantId: TENANT_ID,
    userId: 'sdk:ch-web-prod',
    role: 'sdk_session',
    permissions: ['session:send_message'],
    authType: 'sdk_session',
    isSuperAdmin: false,
    channelId: 'ch-web-prod',
    deploymentId: 'deploy-001',
    ...overrides,
  };
}

function jwtTenantContext(overrides: Partial<TenantContextData> = {}): TenantContextData {
  return {
    tenantId: TENANT_ID,
    userId: 'user-admin-001',
    role: 'ADMIN',
    permissions: ['session:send_message', 'project:read'],
    authType: 'user',
    isSuperAdmin: false,
    ...overrides,
  };
}

function apiKeyTenantContext(overrides: Partial<TenantContextData> = {}): TenantContextData {
  return {
    tenantId: TENANT_ID,
    userId: 'apikey-creator-001',
    role: 'api_key',
    permissions: ['session:send_message'],
    authType: 'api_key',
    isSuperAdmin: false,
    apiKeyId: 'key-001',
    clientId: 'integration-x',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('buildCallerContextFromTenantContext', () => {
  // ---------------------------------------------------------------------------
  // SDK session: identityTier=2 (HMAC-verified)
  // ---------------------------------------------------------------------------
  describe('SDK session with identityTier=2', () => {
    it('reflects tier 2 and verificationMethod on CallerContext', () => {
      const ctx = sdkTenantContext({
        identityTier: 2,
        verificationMethod: 'hmac',
        verifiedUserId: 'verified-user-42',
        authScope: 'user',
      });

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.identityTier).toBe(2);
      expect(result.verificationMethod).toBe('hmac');
      expect(result.channel).toBe('sdk_http');
      expect(result.channelId).toBe('ch-web-prod');
      expect(result.customerId).toBe('verified-user-42');
      expect(result.anonymousId).toBeUndefined();
      expect(result.tenantId).toBe(TENANT_ID);
    });

    it('sets customerId from verifiedUserId for tier 2', () => {
      const ctx = sdkTenantContext({
        identityTier: 2,
        verificationMethod: 'hmac',
        verifiedUserId: 'customer-abc',
        authScope: 'user',
      });

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.customerId).toBe('customer-abc');
      expect(result.anonymousId).toBeUndefined();
    });

    it('carries verified continuity artifacts through to HTTP caller context', () => {
      const ctx = sdkTenantContext({
        identityTier: 2,
        verificationMethod: 'hmac',
        verifiedUserId: 'customer-verified',
        channelArtifact: 'artifact-hash-verified',
        sessionPrincipal: 'sdk-session-verified',
        authScope: 'user',
      });

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.customerId).toBe('customer-verified');
      expect(result.channelArtifact).toBe('artifact-hash-verified');
      expect(result.sessionPrincipalId).toBe('sdk-session-verified');
      expect(result.anonymousId).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // SDK session: identityTier=0 (anonymous)
  // ---------------------------------------------------------------------------
  describe('SDK session with identityTier=0 (anonymous)', () => {
    it('defaults to tier 0 when identityTier not set on token', () => {
      const ctx = sdkTenantContext({
        sessionPrincipal: 'sdk-session-anon',
        authScope: 'session',
      });

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.identityTier).toBe(0);
      expect(result.verificationMethod).toBe('none');
      expect(result.anonymousId).toBe('sdk-session-anon');
      expect(result.sessionPrincipalId).toBe('sdk-session-anon');
      expect(result.customerId).toBeUndefined();
      expect(result.channel).toBe('sdk_http');
    });

    it('sets anonymousId from sessionPrincipal for session-scoped callers', () => {
      const ctx = sdkTenantContext({
        identityTier: 1,
        verificationMethod: 'cookie',
        sessionPrincipal: 'sdk-session-cookie',
        authScope: 'session',
      });

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.identityTier).toBe(1);
      expect(result.verificationMethod).toBe('cookie');
      expect(result.anonymousId).toBe('sdk-session-cookie');
      expect(result.sessionPrincipalId).toBe('sdk-session-cookie');
      expect(result.customerId).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // SDK session with channelArtifact (pre-hashed)
  // ---------------------------------------------------------------------------
  describe('SDK session with channelArtifact', () => {
    it('carries pre-hashed channelArtifact through to CallerContext', () => {
      const preHashedArtifact = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      const ctx = sdkTenantContext({
        identityTier: 1,
        verificationMethod: 'caller_id',
        channelArtifact: preHashedArtifact,
        sessionPrincipal: 'sdk-session-artifact',
        authScope: 'session',
      });

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.channelArtifact).toBe(preHashedArtifact);
      expect(result.sessionPrincipalId).toBe('sdk-session-artifact');
    });

    it('does not set channelArtifact when not present on SDK context', () => {
      const ctx = sdkTenantContext({
        identityTier: 0,
        verificationMethod: 'none',
        // no channelArtifact
      });

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.channelArtifact).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // User JWT auth (identityTier=0, initiatedById set)
  // ---------------------------------------------------------------------------
  describe('user JWT authentication', () => {
    it('defaults to tier 0 and verificationMethod none', () => {
      const ctx = jwtTenantContext();

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.identityTier).toBe(0);
      expect(result.verificationMethod).toBe('none');
      expect(result.channel).toBe('api');
    });

    it('sets initiatedById from userId', () => {
      const ctx = jwtTenantContext({ userId: 'user-admin-001' });

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.initiatedById).toBe('user-admin-001');
    });

    it('does not set customerId or anonymousId', () => {
      const ctx = jwtTenantContext();

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.customerId).toBeUndefined();
      expect(result.anonymousId).toBeUndefined();
    });

    it('does not set channelId for user JWT', () => {
      const ctx = jwtTenantContext();

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.channelId).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // API key auth
  // ---------------------------------------------------------------------------
  describe('API key authentication', () => {
    it('defaults to tier 0 and channel api', () => {
      const ctx = apiKeyTenantContext();

      const result = buildCallerContextFromTenantContext(TENANT_ID, ctx);

      expect(result.identityTier).toBe(0);
      expect(result.verificationMethod).toBe('none');
      expect(result.channel).toBe('api');
      expect(result.initiatedById).toBe('apikey-creator-001');
    });
  });

  // ---------------------------------------------------------------------------
  // Undefined tenant context (edge case)
  // ---------------------------------------------------------------------------
  describe('undefined tenant context', () => {
    it('defaults to tier 0 with api channel', () => {
      const result = buildCallerContextFromTenantContext(TENANT_ID, undefined);

      expect(result.identityTier).toBe(0);
      expect(result.verificationMethod).toBe('none');
      expect(result.channel).toBe('api');
      expect(result.tenantId).toBe(TENANT_ID);
      expect(result.initiatedById).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------------
  describe('tenant isolation', () => {
    it('uses the explicit tenantId parameter, not the one from context', () => {
      const ctx = sdkTenantContext({
        tenantId: 'tenant-from-context',
        identityTier: 2,
        verificationMethod: 'hmac',
      });

      const result = buildCallerContextFromTenantContext('tenant-override', ctx);

      expect(result.tenantId).toBe('tenant-override');
    });
  });
});
