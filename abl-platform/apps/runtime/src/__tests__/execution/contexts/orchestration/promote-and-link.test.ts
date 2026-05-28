/**
 * PromoteAndLink Orchestrator Tests
 *
 * Validates the mid-session identity promotion flow that composes:
 * - PromoteTier (identity context) — validate tier promotion
 * - ResolveOrCreateContact (contact context) — find/create contact
 * - LinkSessionToContact (contact context) — link session to contact
 * - Enqueue back-link and merge detection jobs
 *
 * Test scenarios:
 * - Verification completes -> tier promoted -> contact created -> session linked -> jobs enqueued
 * - Promotion rejected (same tier) -> no contact operations
 * - Contact already exists -> linked without creation (resolveOrCreate returns existing)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PromoteAndLink,
  type PromoteAndLinkDeps,
  type PromoteAndLinkInput,
} from '../../../../contexts/orchestration/use-cases/promote-and-link.js';
import type { IdentityTier, VerificationMethod } from '@agent-platform/shared/types';
import type { ChannelType } from '../../../../channels/types.js';

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT_ID = 'tenant-001';
const SESSION_ID = 'sess-001';
const CONTACT_ID = 'contact-001';
const CHANNEL_TYPE: ChannelType = 'whatsapp';
const CHANNEL_ID = 'ch-whatsapp-prod';

// =============================================================================
// MOCK HELPERS
// =============================================================================

function createMockDeps(overrides: Partial<PromoteAndLinkDeps> = {}): PromoteAndLinkDeps {
  return {
    promoteTier: {
      execute: vi.fn().mockReturnValue({
        success: true,
        newTier: 2 as IdentityTier,
        verificationMethod: 'otp' as VerificationMethod,
      }),
    },
    resolveOrCreateContact: {
      execute: vi.fn().mockResolvedValue({
        contact: {
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
        },
      }),
    },
    linkSession: {
      execute: vi.fn().mockResolvedValue(undefined),
    },
    enqueueJob: vi.fn().mockResolvedValue(undefined),
    registerResolutionKey: {
      execute: vi.fn().mockResolvedValue(undefined),
    },
    recordVerificationProvenance: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createInput(overrides: Partial<PromoteAndLinkInput> = {}): PromoteAndLinkInput {
  return {
    tenantId: TENANT_ID,
    projectId: 'project-001',
    sessionId: SESSION_ID,
    sessionPrincipalId: 'session-principal-001',
    currentTier: 1 as IdentityTier,
    verificationMethod: 'otp' as VerificationMethod,
    verificationAttemptId: 'attempt-001',
    identityType: 'phone',
    identityValue: '+15551234567',
    artifactHash: 'artifact-hash-001',
    channelType: CHANNEL_TYPE,
    channelId: CHANNEL_ID,
    policySource: 'identity_verification_route',
    grantScope: 'user',
    traceId: 'trace-001',
    verifiedAt: new Date('2026-04-23T12:00:00.000Z'),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('PromoteAndLink', () => {
  let deps: PromoteAndLinkDeps;
  let useCase: PromoteAndLink;

  beforeEach(() => {
    deps = createMockDeps();
    useCase = new PromoteAndLink(deps);
  });

  // ---------------------------------------------------------------------------
  // Happy path: verification completes -> full flow
  // ---------------------------------------------------------------------------

  describe('successful promotion and linking', () => {
    it('promotes tier, creates contact, links session, and enqueues jobs', async () => {
      const input = createInput();
      const result = await useCase.execute(input);

      expect(result.promoted).toBe(true);
      expect(result.newTier).toBe(2);
      expect(result.contactId).toBe(CONTACT_ID);
      expect(result.error).toBeUndefined();
    });

    it('calls promoteTier with current tier and verification method', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.promoteTier.execute).toHaveBeenCalledWith({
        currentTier: 1,
        verificationMethod: 'otp',
        resolvedTier: undefined,
      });
    });

    it('passes through a stronger resolved tier for policy-driven provider verification', async () => {
      const input = createInput({
        verificationMethod: 'provider' as VerificationMethod,
        verificationTier: 2 as IdentityTier,
      });
      await useCase.execute(input);

      expect(deps.promoteTier.execute).toHaveBeenCalledWith({
        currentTier: 1,
        verificationMethod: 'provider',
        resolvedTier: 2,
      });
    });

    it('resolves or creates contact with tenant-scoped identity', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.resolveOrCreateContact.execute).toHaveBeenCalledWith(
        TENANT_ID,
        'phone',
        '+15551234567',
        CHANNEL_TYPE,
      );
    });

    it('links session to resolved contact', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.linkSession.execute).toHaveBeenCalledWith(
        TENANT_ID,
        CONTACT_ID,
        SESSION_ID,
        CHANNEL_TYPE,
        CHANNEL_ID,
      );
    });

    it('enqueues BackLinkSessions job', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.enqueueJob).toHaveBeenCalledWith(
        'BackLinkSessions',
        expect.objectContaining({
          tenantId: TENANT_ID,
          contactId: CONTACT_ID,
          sessionId: SESSION_ID,
        }),
      );
    });

    it('enqueues DetectMergeCandidates job', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.enqueueJob).toHaveBeenCalledWith(
        'DetectMergeCandidates',
        expect.objectContaining({
          tenantId: TENANT_ID,
          contactId: CONTACT_ID,
        }),
      );
    });

    it('registers a project-safe resolution record when provenance inputs are present', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.registerResolutionKey?.execute).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        projectId: 'project-001',
        channelId: CHANNEL_ID,
        artifactHash: 'artifact-hash-001',
        sessionLocator: {
          tenantId: TENANT_ID,
          projectId: 'project-001',
          sessionId: SESSION_ID,
        },
        sessionPrincipalId: 'session-principal-001',
        verificationAttemptId: 'attempt-001',
        verificationMethod: 'otp',
        identityTier: 2,
        policySource: 'identity_verification_route',
        grantScope: 'user',
        traceId: 'trace-001',
        verifiedAt: new Date('2026-04-23T12:00:00.000Z'),
        expiresAt: new Date('2026-04-24T12:00:00.000Z'),
      });
    });

    it('emits verification provenance for downstream trace and audit sinks', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.recordVerificationProvenance).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        projectId: 'project-001',
        sessionId: SESSION_ID,
        sessionPrincipalId: 'session-principal-001',
        verificationMethod: 'otp',
        identityTier: 2,
        contactId: CONTACT_ID,
        policySource: 'identity_verification_route',
        grantScope: 'user',
        traceId: 'trace-001',
        verifiedAt: new Date('2026-04-23T12:00:00.000Z'),
        verificationAttemptId: 'attempt-001',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Promotion rejected (same tier) -> no contact operations
  // ---------------------------------------------------------------------------

  describe('promotion rejected (same tier)', () => {
    it('returns promoted false with error when tier cannot be promoted', async () => {
      deps = createMockDeps({
        promoteTier: {
          execute: vi.fn().mockReturnValue({
            success: false,
            error: {
              code: 'TIER_NOT_PROMOTED',
              message: 'Cannot promote from tier 2 to tier 2 via otp',
            },
          }),
        },
      });
      useCase = new PromoteAndLink(deps);

      const input = createInput({ currentTier: 2 as IdentityTier });
      const result = await useCase.execute(input);

      expect(result.promoted).toBe(false);
      expect(result.newTier).toBeUndefined();
      expect(result.contactId).toBeUndefined();
      expect(result.error).toEqual({
        code: 'TIER_NOT_PROMOTED',
        message: 'Cannot promote from tier 2 to tier 2 via otp',
      });
    });

    it('does not call resolveOrCreateContact when promotion fails', async () => {
      deps = createMockDeps({
        promoteTier: {
          execute: vi.fn().mockReturnValue({
            success: false,
            error: { code: 'TIER_NOT_PROMOTED', message: 'no promotion' },
          }),
        },
      });
      useCase = new PromoteAndLink(deps);

      const input = createInput({ currentTier: 2 as IdentityTier });
      await useCase.execute(input);

      expect(deps.resolveOrCreateContact.execute).not.toHaveBeenCalled();
    });

    it('does not call linkSession when promotion fails', async () => {
      deps = createMockDeps({
        promoteTier: {
          execute: vi.fn().mockReturnValue({
            success: false,
            error: { code: 'TIER_NOT_PROMOTED', message: 'no promotion' },
          }),
        },
      });
      useCase = new PromoteAndLink(deps);

      const input = createInput({ currentTier: 2 as IdentityTier });
      await useCase.execute(input);

      expect(deps.linkSession.execute).not.toHaveBeenCalled();
    });

    it('does not enqueue jobs when promotion fails', async () => {
      deps = createMockDeps({
        promoteTier: {
          execute: vi.fn().mockReturnValue({
            success: false,
            error: { code: 'TIER_NOT_PROMOTED', message: 'no promotion' },
          }),
        },
      });
      useCase = new PromoteAndLink(deps);

      const input = createInput({ currentTier: 2 as IdentityTier });
      await useCase.execute(input);

      expect(deps.enqueueJob).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Contact already exists -> linked without creation
  // ---------------------------------------------------------------------------

  describe('contact already exists', () => {
    it('links to existing contact without creating a new one', async () => {
      const existingContact = {
        id: 'existing-contact-999',
        tenantId: TENANT_ID,
        identities: [],
        displayName: 'Existing User',
        type: 'customer' as const,
        metadata: {},
        tags: [],
        channelHistory: [],
        sessionCount: 5,
        firstSeenAt: new Date('2025-01-01'),
        lastSeenAt: new Date('2026-02-18'),
        mergedInto: null,
        deletedAt: null,
      };

      deps = createMockDeps({
        resolveOrCreateContact: {
          execute: vi.fn().mockResolvedValue({ contact: existingContact }),
        },
      });
      useCase = new PromoteAndLink(deps);

      const input = createInput();
      const result = await useCase.execute(input);

      expect(result.promoted).toBe(true);
      expect(result.contactId).toBe('existing-contact-999');
    });

    it('links session to the existing contact', async () => {
      deps = createMockDeps({
        resolveOrCreateContact: {
          execute: vi.fn().mockResolvedValue({
            contact: { id: 'existing-contact-999' },
          }),
        },
      });
      useCase = new PromoteAndLink(deps);

      const input = createInput();
      await useCase.execute(input);

      expect(deps.linkSession.execute).toHaveBeenCalledWith(
        TENANT_ID,
        'existing-contact-999',
        SESSION_ID,
        CHANNEL_TYPE,
        CHANNEL_ID,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Edge: enqueueJob not provided (optional dependency)
  // ---------------------------------------------------------------------------

  describe('no enqueueJob provided', () => {
    it('still completes promotion and linking without enqueueing jobs', async () => {
      deps = createMockDeps({ enqueueJob: undefined });
      useCase = new PromoteAndLink(deps);

      const input = createInput();
      const result = await useCase.execute(input);

      expect(result.promoted).toBe(true);
      expect(result.contactId).toBe(CONTACT_ID);
      expect(result.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // backfillContactId: backfills contactId on session messages
  // ---------------------------------------------------------------------------

  describe('backfillContactId', () => {
    it('calls backfillContactId with tenantId, sessionId, and contactId after linking', async () => {
      const backfillContactId = vi.fn().mockResolvedValue(undefined);
      deps = createMockDeps({ backfillContactId });
      useCase = new PromoteAndLink(deps);

      const input = createInput();
      await useCase.execute(input);

      expect(backfillContactId).toHaveBeenCalledWith(TENANT_ID, SESSION_ID, CONTACT_ID);
      expect(backfillContactId).toHaveBeenCalledTimes(1);
    });

    it('backfills messages without contactId (3 messages scenario)', async () => {
      // Simulate 3 messages that had no contactId — the backfill function is called once
      // and is expected to stamp all of them. We verify the dep is invoked correctly.
      const backfillContactId = vi.fn().mockResolvedValue(undefined);
      deps = createMockDeps({ backfillContactId });
      useCase = new PromoteAndLink(deps);

      const input = createInput();
      const result = await useCase.execute(input);

      expect(result.promoted).toBe(true);
      expect(result.contactId).toBe(CONTACT_ID);
      expect(backfillContactId).toHaveBeenCalledWith(TENANT_ID, SESSION_ID, CONTACT_ID);
    });

    it('does not fail when backfillContactId is not provided', async () => {
      deps = createMockDeps({ backfillContactId: undefined });
      useCase = new PromoteAndLink(deps);

      const input = createInput();
      const result = await useCase.execute(input);

      expect(result.promoted).toBe(true);
      expect(result.contactId).toBe(CONTACT_ID);
    });

    it('does not call backfillContactId when promotion fails', async () => {
      const backfillContactId = vi.fn().mockResolvedValue(undefined);
      deps = createMockDeps({
        backfillContactId,
        promoteTier: {
          execute: vi.fn().mockReturnValue({
            success: false,
            error: { code: 'TIER_NOT_PROMOTED', message: 'no promotion' },
          }),
        },
      });
      useCase = new PromoteAndLink(deps);

      const input = createInput({ currentTier: 2 as IdentityTier });
      await useCase.execute(input);

      expect(backfillContactId).not.toHaveBeenCalled();
    });

    it('calls backfillContactId before enqueueJob', async () => {
      const callOrder: string[] = [];
      const backfillContactId = vi.fn().mockImplementation(async () => {
        callOrder.push('backfill');
      });
      const enqueueJob = vi.fn().mockImplementation(async () => {
        callOrder.push('enqueue');
      });

      deps = createMockDeps({ backfillContactId, enqueueJob });
      useCase = new PromoteAndLink(deps);

      const input = createInput();
      await useCase.execute(input);

      expect(callOrder[0]).toBe('backfill');
      expect(callOrder.slice(1)).toEqual(['enqueue', 'enqueue']);
    });
  });
});
