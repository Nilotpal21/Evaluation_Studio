/**
 * InitializeSession — contact context pre-population tests
 *
 * Validates the new loadContactContext dependency introduced in Phase 3:
 * - Tier 2+ session with contactId gets contact dataValues merged into
 *   callerContext.contactContext and preferences into callerContext.contactPreferences
 * - Tier 0–1 session (no contactId resolved) skips pre-population
 * - Missing contact context (loadContactContext returns null) → no-op
 * - loadContactContext throwing → fail silently, session continues
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InitializeSession,
  type InitializeSessionDeps,
  type InitializeSessionInput,
} from '../../../../contexts/orchestration/use-cases/initialize-session.js';
import type { ResolveSessionResult } from '../../../../contexts/identity/use-cases/resolve-session.js';
import type { ChannelType } from '../../../../channels/types.js';
import type { CallerContext, ChannelArtifactType } from '@agent-platform/shared/types';

// =============================================================================
// LOCAL TYPES (mirror the private types used in the source file)
// =============================================================================

interface ArtifactExtraction {
  rawValue: string;
  artifactType: ChannelArtifactType;
  providerVerified: boolean;
}

interface ReceiveInboundResult {
  message: { senderArtifact: ArtifactExtraction | null } | null;
  artifact: ArtifactExtraction | null;
  error?: { code: string; message: string };
}

interface ContactContextData {
  preferences: Record<string, unknown>;
  dataValues: Record<string, unknown>;
  lastDisposition: string | null;
  lastInteraction: Date | null;
  sessionCount: number;
  updatedAt: Date;
}

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT_ID = 'tenant-prepop-001';
const CHANNEL_ID = 'ch-web-prod';
const CHANNEL_TYPE: ChannelType = 'web_chat';
const NEW_SESSION_ID = 'sess-new-prepop-001';
const CONTACT_ID = 'c1';

const HMAC_ARTIFACT: ArtifactExtraction = {
  rawValue: 'user-id-hmac-verified',
  artifactType: 'device_id',
  providerVerified: false,
};

const ANONYMOUS_ARTIFACT: ArtifactExtraction = {
  rawValue: 'anon-cookie-xyz',
  artifactType: 'cookie',
  providerVerified: false,
};

const STORED_CONTACT_CONTEXT: ContactContextData = {
  preferences: { language: 'fr', timezone: 'UTC' },
  dataValues: { plan: 'enterprise', accountId: 'acct-42' },
  lastDisposition: 'completed',
  lastInteraction: new Date('2026-01-10T09:00:00Z'),
  sessionCount: 7,
  updatedAt: new Date('2026-01-10T09:00:00Z'),
};

// =============================================================================
// MOCK HELPERS
// =============================================================================

function makeReceiveInbound(artifact: ArtifactExtraction) {
  return {
    execute: vi
      .fn<[ChannelType, unknown, Record<string, string>], ReceiveInboundResult>()
      .mockReturnValue({
        message: {
          senderArtifact: artifact,
        },
        artifact,
      }),
  };
}

function makeCallerContextBuilder(tier: number): InitializeSessionDeps['buildCallerContext'] {
  return vi.fn().mockReturnValue({
    tenantId: TENANT_ID,
    channel: CHANNEL_TYPE,
    channelId: CHANNEL_ID,
    identityTier: tier,
    verificationMethod: tier >= 2 ? 'hmac' : 'none',
  } as CallerContext);
}

function createTier2Deps(overrides: Partial<InitializeSessionDeps> = {}): InitializeSessionDeps {
  return {
    receiveInbound: makeReceiveInbound(HMAC_ARTIFACT),
    resolveSession: {
      execute: vi
        .fn<[string, string, string], Promise<ResolveSessionResult>>()
        .mockResolvedValue({ found: false }),
    },
    registerResolutionKey: {
      execute: vi.fn().mockResolvedValue(undefined),
    },
    resolveOrCreateContact: {
      execute: vi.fn().mockResolvedValue({ contact: { id: CONTACT_ID } }),
    },
    linkSessionToContact: {
      execute: vi.fn().mockResolvedValue(undefined),
    },
    hashArtifact: vi.fn<[string], string>().mockReturnValue('hashed-hmac'),
    buildCallerContext: makeCallerContextBuilder(2),
    loadContactContext: vi
      .fn<[string, string], Promise<ContactContextData | null>>()
      .mockResolvedValue(STORED_CONTACT_CONTEXT),
    ...overrides,
  };
}

function createTier0Deps(overrides: Partial<InitializeSessionDeps> = {}): InitializeSessionDeps {
  return {
    receiveInbound: makeReceiveInbound(ANONYMOUS_ARTIFACT),
    resolveSession: {
      execute: vi
        .fn<[string, string, string], Promise<ResolveSessionResult>>()
        .mockResolvedValue({ found: false }),
    },
    registerResolutionKey: {
      execute: vi.fn().mockResolvedValue(undefined),
    },
    // No contact ports — anonymous session
    resolveOrCreateContact: undefined,
    linkSessionToContact: undefined,
    hashArtifact: vi.fn<[string], string>().mockReturnValue('hashed-anon'),
    buildCallerContext: makeCallerContextBuilder(0),
    loadContactContext: vi.fn(),
    ...overrides,
  };
}

function makeInput(overrides: Partial<InitializeSessionInput> = {}): InitializeSessionInput {
  return {
    tenantId: TENANT_ID,
    channelType: CHANNEL_TYPE,
    channelId: CHANNEL_ID,
    rawPayload: { body: 'Hello' },
    headers: {},
    newSessionId: NEW_SESSION_ID,
    identityTier: 2,
    verificationMethod: 'hmac',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('InitializeSession — contact context pre-population', () => {
  // ---------------------------------------------------------------------------
  // Tier 2+ with contactId — happy path
  // ---------------------------------------------------------------------------

  describe('tier 2+ session with resolved contactId', () => {
    it('merges dataValues into callerContext.contactContext', async () => {
      const deps = createTier2Deps();
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(makeInput({ identityTier: 2 }));

      expect(result.callerContext).toMatchObject({
        contactContext: STORED_CONTACT_CONTEXT.dataValues,
      });
    });

    it('merges preferences into callerContext.contactPreferences', async () => {
      const deps = createTier2Deps();
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(makeInput({ identityTier: 2 }));

      expect(result.callerContext).toMatchObject({
        contactPreferences: STORED_CONTACT_CONTEXT.preferences,
      });
    });

    it('calls loadContactContext with correct tenantId and contactId', async () => {
      const deps = createTier2Deps();
      const useCase = new InitializeSession(deps);

      await useCase.execute(makeInput({ identityTier: 2 }));

      expect(deps.loadContactContext).toHaveBeenCalledWith(TENANT_ID, CONTACT_ID);
    });

    it('still returns the resolved contactId in the result', async () => {
      const deps = createTier2Deps();
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(makeInput({ identityTier: 2 }));

      expect(result.contactId).toBe(CONTACT_ID);
    });

    it('works for provider-verified tier 1 artifact (providerVerified=true)', async () => {
      const providerArtifact: ArtifactExtraction = {
        rawValue: '+15551234567',
        artifactType: 'phone',
        providerVerified: true,
      };
      const deps = createTier2Deps({
        receiveInbound: makeReceiveInbound(providerArtifact),
        buildCallerContext: makeCallerContextBuilder(1),
      });
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(
        makeInput({ identityTier: 1, verificationMethod: 'provider' }),
      );

      // providerVerified=true triggers contact resolution, which triggers pre-population
      expect(result.callerContext).toMatchObject({
        contactContext: STORED_CONTACT_CONTEXT.dataValues,
        contactPreferences: STORED_CONTACT_CONTEXT.preferences,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Tier 0–1 session (no contactId) — skips pre-population
  // ---------------------------------------------------------------------------

  describe('tier 0 session — no contact resolution, no pre-population', () => {
    it('does not call loadContactContext when contactId is not resolved', async () => {
      const deps = createTier0Deps();
      const useCase = new InitializeSession(deps);

      await useCase.execute(makeInput({ identityTier: 0, verificationMethod: 'none' }));

      expect(deps.loadContactContext).not.toHaveBeenCalled();
    });

    it('does not set contactContext or contactPreferences on callerContext', async () => {
      const deps = createTier0Deps();
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(
        makeInput({ identityTier: 0, verificationMethod: 'none' }),
      );

      expect((result.callerContext as Record<string, unknown>).contactContext).toBeUndefined();
      expect((result.callerContext as Record<string, unknown>).contactPreferences).toBeUndefined();
    });

    it('returns undefined contactId for anonymous session', async () => {
      const deps = createTier0Deps();
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(
        makeInput({ identityTier: 0, verificationMethod: 'none' }),
      );

      expect(result.contactId).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // loadContactContext returns null — no-op
  // ---------------------------------------------------------------------------

  describe('loadContactContext returns null', () => {
    it('does not set contactContext when no stored context exists', async () => {
      const deps = createTier2Deps({
        loadContactContext: vi.fn().mockResolvedValue(null),
      });
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(makeInput({ identityTier: 2 }));

      expect((result.callerContext as Record<string, unknown>).contactContext).toBeUndefined();
      expect((result.callerContext as Record<string, unknown>).contactPreferences).toBeUndefined();
    });

    it('still resolves and links the contact even when context is null', async () => {
      const deps = createTier2Deps({
        loadContactContext: vi.fn().mockResolvedValue(null),
      });
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(makeInput({ identityTier: 2 }));

      expect(result.contactId).toBe(CONTACT_ID);
      expect(deps.resolveOrCreateContact!.execute).toHaveBeenCalled();
      expect(deps.linkSessionToContact!.execute).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // loadContactContext throws — fail silently
  // ---------------------------------------------------------------------------

  describe('loadContactContext throws — fail silently', () => {
    it('does not propagate the error to the caller', async () => {
      const deps = createTier2Deps({
        loadContactContext: vi.fn().mockRejectedValue(new Error('DB timeout')),
      });
      const useCase = new InitializeSession(deps);

      await expect(useCase.execute(makeInput({ identityTier: 2 }))).resolves.toBeDefined();
    });

    it('session still succeeds and returns contactId even when loadContactContext throws', async () => {
      const deps = createTier2Deps({
        loadContactContext: vi.fn().mockRejectedValue(new Error('Redis unreachable')),
      });
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(makeInput({ identityTier: 2 }));

      expect(result.resolution).toBe('create');
      expect(result.contactId).toBe(CONTACT_ID);
    });

    it('does not set contactContext or contactPreferences when loadContactContext throws', async () => {
      const deps = createTier2Deps({
        loadContactContext: vi.fn().mockRejectedValue(new Error('network error')),
      });
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(makeInput({ identityTier: 2 }));

      expect((result.callerContext as Record<string, unknown>).contactContext).toBeUndefined();
      expect((result.callerContext as Record<string, unknown>).contactPreferences).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // loadContactContext not provided (undefined)
  // ---------------------------------------------------------------------------

  describe('loadContactContext not provided', () => {
    it('skips pre-population when loadContactContext dep is absent', async () => {
      const deps = createTier2Deps({ loadContactContext: undefined });
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(makeInput({ identityTier: 2 }));

      expect((result.callerContext as Record<string, unknown>).contactContext).toBeUndefined();
      expect((result.callerContext as Record<string, unknown>).contactPreferences).toBeUndefined();
    });

    it('contact is still resolved and linked even without loadContactContext', async () => {
      const deps = createTier2Deps({ loadContactContext: undefined });
      const useCase = new InitializeSession(deps);

      const result = await useCase.execute(makeInput({ identityTier: 2 }));

      expect(result.contactId).toBe(CONTACT_ID);
      expect(deps.resolveOrCreateContact!.execute).toHaveBeenCalled();
    });
  });
});
