/**
 * InitializeSession Orchestrator Tests
 *
 * Validates the hot path that composes channel, identity, and contact use cases:
 * - New session: resolve returns not found -> builds CallerContext + registers key
 * - Existing session: resolve returns found -> resumes, no key registration
 * - providerVerified artifact defaults to tier 1 and resolves contact
 * - strong provider verification policy promotes trusted channels to tier 2
 * - Tier 0 (anonymous) -> no contact operations
 * - Tier 2 (HMAC verified) -> contact resolved + linked
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InitializeSession,
  type InitializeSessionDeps,
  type InitializeSessionInput,
  type InitializeSessionResult,
} from '../../../../contexts/orchestration/use-cases/initialize-session.js';
import type { ResolveSessionResult } from '../../../../contexts/identity/use-cases/resolve-session.js';
import type { ChannelType } from '../../../../channels/types.js';
import type { CallerContext, ChannelArtifactType } from '@agent-platform/shared/types';

// Types from the deleted channel context (used only in test mocks)
interface ArtifactExtraction {
  rawValue: string;
  artifactType: import('@agent-platform/shared/types').ChannelArtifactType;
  providerVerified: boolean;
}
interface ReceiveInboundResult {
  message: { senderArtifact: ArtifactExtraction | null } | null;
  artifact: ArtifactExtraction | null;
  error?: { code: string; message: string };
}

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT_ID = 'tenant-001';
const CHANNEL_ID = 'ch-whatsapp-prod';
const CHANNEL_TYPE: ChannelType = 'whatsapp';
const SESSION_ID = 'sess-existing-001';
const NEW_SESSION_ID = 'sess-new-001';
const CONTACT_ID = 'contact-001';

const WHATSAPP_ARTIFACT: ArtifactExtraction = {
  rawValue: '+15551234567',
  artifactType: 'phone',
  providerVerified: true,
};

const ANONYMOUS_ARTIFACT: ArtifactExtraction = {
  rawValue: 'anon-cookie-abc123',
  artifactType: 'cookie',
  providerVerified: false,
};

const HMAC_ARTIFACT: ArtifactExtraction = {
  rawValue: 'user-id-verified-hmac',
  artifactType: 'device_id',
  providerVerified: false,
};

// =============================================================================
// MOCK HELPERS
// =============================================================================

function createMockDeps(overrides: Partial<InitializeSessionDeps> = {}): InitializeSessionDeps {
  return {
    receiveInbound: {
      execute: vi
        .fn<[ChannelType, unknown, Record<string, string>], ReceiveInboundResult>()
        .mockReturnValue({
          message: {
            channelType: CHANNEL_TYPE,
            text: 'Hello',
            media: [],
            metadata: {},
            senderArtifact: WHATSAPP_ARTIFACT,
            timestamp: new Date('2026-02-18T12:00:00Z'),
            providerMessageId: 'msg-001',
          },
          artifact: WHATSAPP_ARTIFACT,
        }),
    },
    resolveSession: {
      execute: vi.fn<[string, string, string], Promise<ResolveSessionResult>>().mockResolvedValue({
        found: false,
      }),
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
    hashArtifact: vi.fn<[string], string>().mockReturnValue('hashed-artifact-value'),
    buildCallerContext: vi.fn<[unknown], CallerContext>().mockReturnValue({
      tenantId: TENANT_ID,
      channel: CHANNEL_TYPE,
      channelId: CHANNEL_ID,
      identityTier: 1,
      verificationMethod: 'provider',
    }),
    ...overrides,
  };
}

function createInput(overrides: Partial<InitializeSessionInput> = {}): InitializeSessionInput {
  return {
    tenantId: TENANT_ID,
    channelType: CHANNEL_TYPE,
    channelId: CHANNEL_ID,
    rawPayload: { body: 'Hello' },
    headers: { 'x-hub-signature': 'sig123' },
    newSessionId: NEW_SESSION_ID,
    identityTier: 1,
    verificationMethod: 'provider',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('InitializeSession', () => {
  let deps: InitializeSessionDeps;
  let useCase: InitializeSession;

  beforeEach(() => {
    deps = createMockDeps();
    useCase = new InitializeSession(deps);
  });

  // ---------------------------------------------------------------------------
  // New session (resolve returns not found)
  // ---------------------------------------------------------------------------

  describe('new session creation', () => {
    it('returns create resolution with CallerContext and registered key', async () => {
      const input = createInput();
      const result = await useCase.execute(input);

      expect(result.resolution).toBe('create');
      expect(result.sessionId).toBeUndefined();
      expect(result.callerContext).toBeDefined();
      expect(result.artifact).toBeDefined();
      expect(result.artifact?.hash).toBe('hashed-artifact-value');
      expect(result.artifact?.type).toBe('phone');
    });

    it('calls receiveInbound with correct channel/payload/headers', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.receiveInbound.execute).toHaveBeenCalledWith(
        CHANNEL_TYPE,
        { body: 'Hello' },
        { 'x-hub-signature': 'sig123' },
      );
    });

    it('hashes the artifact raw value', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.hashArtifact).toHaveBeenCalledWith('+15551234567');
    });

    it('resolves session with tenant, channel, and hashed artifact', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.resolveSession.execute).toHaveBeenCalledWith(
        TENANT_ID,
        CHANNEL_ID,
        'hashed-artifact-value',
      );
    });

    it('builds CallerContext from artifact and tier', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.buildCallerContext).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          channel: CHANNEL_TYPE,
          channelId: CHANNEL_ID,
          identityTier: 1,
          verificationMethod: 'provider',
          rawArtifact: '+15551234567',
          channelArtifactType: 'phone',
        }),
      );
    });

    it('registers resolution key for new sessions', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.registerResolutionKey.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          channelId: CHANNEL_ID,
          artifactHash: 'hashed-artifact-value',
          sessionId: NEW_SESSION_ID,
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Existing session (resolve returns found)
  // ---------------------------------------------------------------------------

  describe('session resumption', () => {
    it('returns resume resolution with existing sessionId', async () => {
      deps = createMockDeps({
        resolveSession: {
          execute: vi.fn().mockResolvedValue({ found: true, sessionId: SESSION_ID }),
        },
      });
      useCase = new InitializeSession(deps);

      const input = createInput();
      const result = await useCase.execute(input);

      expect(result.resolution).toBe('resume');
      expect(result.sessionId).toBe(SESSION_ID);
      expect(result.callerContext).toBeDefined();
    });

    it('does not register resolution key when resuming', async () => {
      deps = createMockDeps({
        resolveSession: {
          execute: vi.fn().mockResolvedValue({ found: true, sessionId: SESSION_ID }),
        },
      });
      useCase = new InitializeSession(deps);

      const input = createInput();
      await useCase.execute(input);

      expect(deps.registerResolutionKey.execute).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Provider-verified artifact -> contact resolved + linked
  // ---------------------------------------------------------------------------

  describe('providerVerified artifact (default tier 1)', () => {
    it('resolves or creates contact for providerVerified artifact', async () => {
      const input = createInput({
        identityTier: 1,
        verificationMethod: 'provider',
      });
      // Default mock already has providerVerified: true on the artifact
      await useCase.execute(input);

      expect(deps.resolveOrCreateContact!.execute).toHaveBeenCalledWith(
        TENANT_ID,
        'phone',
        '+15551234567',
        CHANNEL_TYPE,
      );
    });

    it('links session to contact for providerVerified artifact', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.linkSessionToContact!.execute).toHaveBeenCalledWith(
        TENANT_ID,
        CONTACT_ID,
        NEW_SESSION_ID,
        CHANNEL_TYPE,
        CHANNEL_ID,
      );
    });

    it('includes contactId in result when contact is resolved', async () => {
      const input = createInput();
      const result = await useCase.execute(input);

      expect(result.contactId).toBe(CONTACT_ID);
    });

    it('keeps callerContext at tier 1 when no strong provider policy is configured', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.buildCallerContext).toHaveBeenCalledWith(
        expect.objectContaining({
          identityTier: 1,
          verificationMethod: 'provider',
        }),
      );
    });
  });

  describe('providerVerified artifact with strong policy', () => {
    it('promotes callerContext to tier 2 for trusted provider-verified channels', async () => {
      const input = createInput({
        identityTier: 1,
        verificationMethod: 'provider',
        providerVerificationStrength: 'strong',
      });
      await useCase.execute(input);

      expect(deps.buildCallerContext).toHaveBeenCalledWith(
        expect.objectContaining({
          identityTier: 2,
          verificationMethod: 'provider',
        }),
      );
    });

    it('does not downgrade stronger non-provider verification when provider verification is weak', async () => {
      deps = createMockDeps({
        buildCallerContext: vi.fn().mockReturnValue({
          tenantId: TENANT_ID,
          channel: 'web_chat',
          channelId: CHANNEL_ID,
          identityTier: 2,
          verificationMethod: 'hmac',
        }),
      });
      useCase = new InitializeSession(deps);

      const input = createInput({
        channelType: 'web_chat',
        identityTier: 2,
        verificationMethod: 'hmac',
      });
      await useCase.execute(input);

      expect(deps.buildCallerContext).toHaveBeenCalledWith(
        expect.objectContaining({
          identityTier: 2,
          verificationMethod: 'hmac',
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Tier 0 (anonymous) -> no contact operations
  // ---------------------------------------------------------------------------

  describe('anonymous identity (tier 0)', () => {
    it('does not resolve or create contact', async () => {
      deps = createMockDeps({
        receiveInbound: {
          execute: vi.fn().mockReturnValue({
            message: {
              channelType: 'web_chat',
              text: 'Hi',
              media: [],
              metadata: {},
              senderArtifact: ANONYMOUS_ARTIFACT,
              timestamp: new Date('2026-02-18T12:00:00Z'),
              providerMessageId: null,
            },
            artifact: ANONYMOUS_ARTIFACT,
          }),
        },
        buildCallerContext: vi.fn().mockReturnValue({
          tenantId: TENANT_ID,
          channel: 'web_chat',
          identityTier: 0,
          verificationMethod: 'none',
        }),
      });
      useCase = new InitializeSession(deps);

      const input = createInput({
        channelType: 'web_chat',
        identityTier: 0,
        verificationMethod: 'none',
      });
      const result = await useCase.execute(input);

      expect(deps.resolveOrCreateContact!.execute).not.toHaveBeenCalled();
      expect(deps.linkSessionToContact!.execute).not.toHaveBeenCalled();
      expect(result.contactId).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tier 2 (HMAC verified) -> contact resolved + linked
  // ---------------------------------------------------------------------------

  describe('HMAC-verified identity (tier 2)', () => {
    it('resolves or creates contact for tier 2', async () => {
      deps = createMockDeps({
        receiveInbound: {
          execute: vi.fn().mockReturnValue({
            message: {
              channelType: 'web_chat',
              text: 'Hi',
              media: [],
              metadata: {},
              senderArtifact: HMAC_ARTIFACT,
              timestamp: new Date('2026-02-18T12:00:00Z'),
              providerMessageId: null,
            },
            artifact: HMAC_ARTIFACT,
          }),
        },
        buildCallerContext: vi.fn().mockReturnValue({
          tenantId: TENANT_ID,
          channel: 'web_chat',
          channelId: CHANNEL_ID,
          identityTier: 2,
          verificationMethod: 'hmac',
        }),
      });
      useCase = new InitializeSession(deps);

      const input = createInput({
        channelType: 'web_chat',
        identityTier: 2,
        verificationMethod: 'hmac',
      });
      const result = await useCase.execute(input);

      expect(deps.resolveOrCreateContact!.execute).toHaveBeenCalledWith(
        TENANT_ID,
        'device_id',
        'user-id-verified-hmac',
        'web_chat',
      );
      expect(deps.linkSessionToContact!.execute).toHaveBeenCalled();
      expect(result.contactId).toBe(CONTACT_ID);
    });

    it('links session to resolved contact for tier 2', async () => {
      deps = createMockDeps({
        receiveInbound: {
          execute: vi.fn().mockReturnValue({
            message: {
              channelType: 'web_chat',
              text: 'Hi',
              media: [],
              metadata: {},
              senderArtifact: HMAC_ARTIFACT,
              timestamp: new Date('2026-02-18T12:00:00Z'),
              providerMessageId: null,
            },
            artifact: HMAC_ARTIFACT,
          }),
        },
        buildCallerContext: vi.fn().mockReturnValue({
          tenantId: TENANT_ID,
          channel: 'web_chat',
          channelId: CHANNEL_ID,
          identityTier: 2,
          verificationMethod: 'hmac',
        }),
      });
      useCase = new InitializeSession(deps);

      const input = createInput({
        channelType: 'web_chat',
        identityTier: 2,
        verificationMethod: 'hmac',
      });
      await useCase.execute(input);

      expect(deps.linkSessionToContact!.execute).toHaveBeenCalledWith(
        TENANT_ID,
        CONTACT_ID,
        NEW_SESSION_ID,
        'web_chat',
        CHANNEL_ID,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('returns error when inbound message normalization fails', async () => {
      deps = createMockDeps({
        receiveInbound: {
          execute: vi.fn().mockReturnValue({
            message: null,
            artifact: null,
            error: { code: 'NORMALIZE_FAILED', message: 'Bad payload' },
          }),
        },
      });
      useCase = new InitializeSession(deps);

      const input = createInput();

      await expect(useCase.execute(input)).rejects.toThrow('NORMALIZE_FAILED');
    });

    it('returns error when no artifact is extracted', async () => {
      deps = createMockDeps({
        receiveInbound: {
          execute: vi.fn().mockReturnValue({
            message: {
              channelType: 'web_chat',
              text: 'Hi',
              media: [],
              metadata: {},
              senderArtifact: null,
              timestamp: new Date(),
              providerMessageId: null,
            },
            artifact: null,
          }),
        },
      });
      useCase = new InitializeSession(deps);

      const input = createInput();

      await expect(useCase.execute(input)).rejects.toThrow('NO_ARTIFACT');
    });

    it('skips contact operations when contact ports are not provided', async () => {
      deps = createMockDeps({
        resolveOrCreateContact: undefined,
        linkSessionToContact: undefined,
      });
      useCase = new InitializeSession(deps);

      // Even with providerVerified artifact, no contact operations should happen
      const input = createInput();
      const result = await useCase.execute(input);

      expect(result.contactId).toBeUndefined();
      expect(result.resolution).toBe('create');
    });
  });
});
