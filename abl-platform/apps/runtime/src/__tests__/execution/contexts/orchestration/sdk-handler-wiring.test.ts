/**
 * SDK Handler Contact Wiring Tests
 *
 * Validates that the `resolveAndLinkContact` helper correctly:
 * - Calls ResolveOrCreateContact + LinkSessionToContact for human SDK callers
 * - Resolves verified users via customerId and guests via session/anonymous identity
 * - Skips when no canonical human identity hint is available
 * - Does not throw on contact operation failure (fire-and-forget)
 * - Passes correct tenant, identity, channel, and session parameters
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveContactForProductionScope,
  resolveAndLinkContact,
  type ContactLinkingDeps,
  type ContactLinkingState,
} from '../../../../websocket/sdk-handler-contact-linking.js';

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT_ID = 'tenant-sdk-001';
const SESSION_ID = 'runtime-sess-001';
const CUSTOMER_ID = 'customer-verified-42';
const CHANNEL_ID = 'ch-web-prod';
const CONTACT_ID = 'contact-resolved-001';

function tier2State(overrides: Partial<ContactLinkingState> = {}): ContactLinkingState {
  return {
    tenantId: TENANT_ID,
    channelId: CHANNEL_ID,
    callerContext: {
      tenantId: TENANT_ID,
      identityTier: 2,
      verificationMethod: 'hmac',
      channel: 'sdk_websocket',
      channelId: CHANNEL_ID,
      customerId: CUSTOMER_ID,
    },
    sessionId: 'ws-sess-001',
    ...overrides,
  };
}

function tier0State(overrides: Partial<ContactLinkingState> = {}): ContactLinkingState {
  return {
    tenantId: TENANT_ID,
    channelId: CHANNEL_ID,
    callerContext: {
      tenantId: TENANT_ID,
      identityTier: 0,
      verificationMethod: 'none',
      channel: 'sdk_websocket',
      channelId: CHANNEL_ID,
      anonymousId: 'anon-device-xyz',
    },
    sessionId: 'ws-sess-002',
    ...overrides,
  };
}

function tier1State(overrides: Partial<ContactLinkingState> = {}): ContactLinkingState {
  return {
    tenantId: TENANT_ID,
    channelId: CHANNEL_ID,
    callerContext: {
      tenantId: TENANT_ID,
      identityTier: 1,
      verificationMethod: 'cookie',
      channel: 'sdk_websocket',
      channelId: CHANNEL_ID,
      anonymousId: 'cookie-device-001',
    },
    sessionId: 'ws-sess-003',
    ...overrides,
  };
}

function createMockDeps(): ContactLinkingDeps {
  return {
    resolveOrCreateContact: {
      execute: vi.fn().mockResolvedValue({
        id: CONTACT_ID,
        tenantId: TENANT_ID,
        identities: [],
        displayName: null,
        type: 'customer',
        metadata: {},
        tags: [],
        channelHistory: [],
        sessionCount: 0,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        mergedInto: null,
        deletedAt: null,
        encryptionSalt: null,
        contactContext: null,
      }),
    },
    linkSessionToContact: {
      execute: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('resolveAndLinkContact', () => {
  let deps: ContactLinkingDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  // ---------------------------------------------------------------------------
  // Tier 2+ (verified) -> contact operations should fire
  // ---------------------------------------------------------------------------
  describe('tier 2+ user (verified identity)', () => {
    it('calls ResolveOrCreateContact with correct tenantId and customerId', async () => {
      await resolveAndLinkContact(tier2State(), SESSION_ID, deps);

      expect(deps.resolveOrCreateContact.execute).toHaveBeenCalledOnce();
      expect(deps.resolveOrCreateContact.execute).toHaveBeenCalledWith(
        TENANT_ID,
        'external',
        CUSTOMER_ID,
        'sdk_websocket',
        {
          contactAuditSource: 'customer_id',
          suppressContactCreatedAudit: false,
        },
      );
    });

    it('calls LinkSessionToContact with resolved contactId and canonical sessionId', async () => {
      await resolveAndLinkContact(tier2State(), SESSION_ID, deps);

      expect(deps.linkSessionToContact.execute).toHaveBeenCalledOnce();
      expect(deps.linkSessionToContact.execute).toHaveBeenCalledWith(
        TENANT_ID,
        CONTACT_ID,
        SESSION_ID,
        'sdk_websocket',
        CHANNEL_ID,
      );
    });

    it('returns the resolved contactId and displayName', async () => {
      const result = await resolveAndLinkContact(tier2State(), SESSION_ID, deps);

      expect(result).toEqual({ contactId: CONTACT_ID, displayName: null });
    });
  });

  // ---------------------------------------------------------------------------
  // Tier 0 (anonymous) -> contact operations resolve via anonymous/session identity
  // ---------------------------------------------------------------------------
  describe('tier 0 user (anonymous)', () => {
    it('resolves a canonical contact from anonymous identity', async () => {
      const result = await resolveAndLinkContact(tier0State(), SESSION_ID, deps);

      expect(deps.resolveOrCreateContact.execute).toHaveBeenCalledWith(
        TENANT_ID,
        'external',
        'anon-device-xyz',
        'sdk_websocket',
        {
          contactAuditSource: 'anonymous_id',
          suppressContactCreatedAudit: true,
        },
      );
      expect(result).toEqual({ contactId: CONTACT_ID, displayName: null });
    });

    it('links the resolved contact to the runtime session', async () => {
      await resolveAndLinkContact(tier0State(), SESSION_ID, deps);

      expect(deps.linkSessionToContact.execute).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // Tier 1 (cookie/device) -> contact operations still resolve a canonical subject
  // ---------------------------------------------------------------------------
  describe('tier 1 user (device identity)', () => {
    it('resolves contact operations from anonymous identity', async () => {
      const result = await resolveAndLinkContact(tier1State(), SESSION_ID, deps);

      expect(deps.resolveOrCreateContact.execute).toHaveBeenCalledWith(
        TENANT_ID,
        'external',
        'cookie-device-001',
        'sdk_websocket',
        {
          contactAuditSource: 'anonymous_id',
          suppressContactCreatedAudit: true,
        },
      );
      expect(deps.linkSessionToContact.execute).toHaveBeenCalledOnce();
      expect(result).toEqual({ contactId: CONTACT_ID, displayName: null });
    });
  });

  // ---------------------------------------------------------------------------
  // Tier 2 but no customerId -> falls back to session principal / anonymous identity
  // ---------------------------------------------------------------------------
  describe('tier 2 without customerId', () => {
    it('resolves from session principal when customerId is missing', async () => {
      const state = tier2State({
        callerContext: {
          tenantId: TENANT_ID,
          identityTier: 2,
          verificationMethod: 'hmac',
          channel: 'sdk_websocket',
          channelId: CHANNEL_ID,
          sessionPrincipalId: 'session-principal-77',
        },
      });

      const result = await resolveAndLinkContact(state, SESSION_ID, deps);

      expect(deps.resolveOrCreateContact.execute).toHaveBeenCalledWith(
        TENANT_ID,
        'external',
        'session-principal-77',
        'sdk_websocket',
        {
          contactAuditSource: 'session_principal',
          suppressContactCreatedAudit: true,
        },
      );
      expect(deps.linkSessionToContact.execute).toHaveBeenCalledOnce();
      expect(result).toEqual({ contactId: CONTACT_ID, displayName: null });
    });
  });

  // ---------------------------------------------------------------------------
  // Missing tenantId -> no contact operations
  // ---------------------------------------------------------------------------
  describe('missing tenantId', () => {
    it('skips contact operations when tenantId is missing', async () => {
      const state = tier2State({ tenantId: undefined });

      const result = await resolveAndLinkContact(state, SESSION_ID, deps);

      expect(deps.resolveOrCreateContact.execute).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Missing callerContext -> no contact operations
  // ---------------------------------------------------------------------------
  describe('missing callerContext', () => {
    it('skips contact operations when callerContext is absent', async () => {
      const state = tier2State({ callerContext: undefined });

      const result = await resolveAndLinkContact(state, SESSION_ID, deps);

      expect(deps.resolveOrCreateContact.execute).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling: ResolveOrCreateContact fails -> no throw, returns undefined
  // ---------------------------------------------------------------------------
  describe('error handling', () => {
    it('returns undefined when ResolveOrCreateContact fails', async () => {
      deps.resolveOrCreateContact.execute = vi
        .fn()
        .mockRejectedValue(new Error('DB connection lost'));

      const result = await resolveAndLinkContact(tier2State(), SESSION_ID, deps);

      expect(result).toBeUndefined();
      expect(deps.linkSessionToContact.execute).not.toHaveBeenCalled();
    });

    it('returns contactId even when LinkSessionToContact fails', async () => {
      deps.linkSessionToContact.execute = vi.fn().mockRejectedValue(new Error('Link failed'));

      const result = await resolveAndLinkContact(tier2State(), SESSION_ID, deps);

      // Contact was resolved, linking failed but we still have the contactId
      expect(deps.resolveOrCreateContact.execute).toHaveBeenCalledOnce();
      expect(result).toEqual({ contactId: CONTACT_ID, displayName: null });
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation: uses state.tenantId, not callerContext.tenantId
  // ---------------------------------------------------------------------------
  describe('tenant isolation', () => {
    it('passes state.tenantId to ResolveOrCreateContact', async () => {
      const state = tier2State({
        tenantId: 'tenant-from-state',
        callerContext: {
          tenantId: 'tenant-from-context',
          identityTier: 2,
          verificationMethod: 'hmac',
          channel: 'sdk_websocket',
          channelId: CHANNEL_ID,
          customerId: CUSTOMER_ID,
        },
      });

      await resolveAndLinkContact(state, SESSION_ID, deps);

      expect(deps.resolveOrCreateContact.execute).toHaveBeenCalledWith(
        'tenant-from-state',
        'external',
        CUSTOMER_ID,
        'sdk_websocket',
        {
          contactAuditSource: 'customer_id',
          suppressContactCreatedAudit: false,
        },
      );
    });
  });
});

describe('resolveContactForProductionScope', () => {
  let deps: ContactLinkingDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('resolves a verified SDK caller into a canonical contact without linking the session', async () => {
    const result = await resolveContactForProductionScope(tier2State(), deps);

    expect(result).toEqual({ contactId: CONTACT_ID, displayName: null });
    expect(deps.resolveOrCreateContact.execute).toHaveBeenCalledOnce();
    expect(deps.linkSessionToContact.execute).not.toHaveBeenCalled();
  });

  it('resolves a guest SDK caller into a canonical contact without linking the session', async () => {
    const result = await resolveContactForProductionScope(tier0State(), deps);

    expect(result).toEqual({ contactId: CONTACT_ID, displayName: null });
    expect(deps.resolveOrCreateContact.execute).toHaveBeenCalledWith(
      TENANT_ID,
      'external',
      'anon-device-xyz',
      'sdk_websocket',
      {
        contactAuditSource: 'anonymous_id',
        suppressContactCreatedAudit: true,
      },
    );
    expect(deps.linkSessionToContact.execute).not.toHaveBeenCalled();
  });
});
