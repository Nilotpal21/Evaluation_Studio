/**
 * SwitchChannel Orchestrator Tests
 *
 * Validates cross-channel continuity when a verified user appears on a new channel:
 * - Tier 2 user on new channel -> contact found -> session created + linked
 * - resumeCrossChannel: true -> carries context from previous session
 * - resumeCrossChannel: false -> creates fresh session, still links contact
 * - Contact not found (tier < 2) -> no cross-channel, returns unlinked result
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SwitchChannel,
  type SwitchChannelDeps,
  type SwitchChannelInput,
  type SwitchChannelResult,
} from '../../../../contexts/orchestration/use-cases/switch-channel.js';
import type { ChannelType } from '../../../../channels/types.js';

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT_ID = 'tenant-switch-001';
const SESSION_ID = 'sess-new-channelB';
const CONTACT_ID = 'contact-cross-001';
const CHANNEL_TYPE_B: ChannelType = 'whatsapp';
const CHANNEL_ID_B = 'ch-whatsapp-prod';

const PREVIOUS_CONTEXT: Record<string, unknown> = {
  lastTopic: 'billing-inquiry',
  preferredLanguage: 'en',
  cartItems: ['item-a', 'item-b'],
};

// =============================================================================
// MOCK HELPERS
// =============================================================================

function createMockDeps(overrides: Partial<SwitchChannelDeps> = {}): SwitchChannelDeps {
  return {
    resolveOrCreateContact: {
      execute: vi.fn().mockResolvedValue({ contact: { id: CONTACT_ID } }),
    },
    linkSession: {
      execute: vi.fn().mockResolvedValue(undefined),
    },
    loadPreviousSessionContext: vi.fn().mockResolvedValue(PREVIOUS_CONTEXT),
    ...overrides,
  };
}

function createInput(overrides: Partial<SwitchChannelInput> = {}): SwitchChannelInput {
  return {
    tenantId: TENANT_ID,
    sessionId: SESSION_ID,
    identityType: 'phone',
    identityValue: '+15551234567',
    channelType: CHANNEL_TYPE_B,
    channelId: CHANNEL_ID_B,
    identityTier: 2,
    resumeCrossChannel: true,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('SwitchChannel', () => {
  let deps: SwitchChannelDeps;
  let useCase: SwitchChannel;

  beforeEach(() => {
    deps = createMockDeps();
    useCase = new SwitchChannel(deps);
  });

  // ---------------------------------------------------------------------------
  // Tier 2 user on new channel -> contact found -> session created + linked
  // ---------------------------------------------------------------------------

  describe('tier 2 user on new channel with contact found', () => {
    it('resolves or creates contact with tenant-scoped identity', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.resolveOrCreateContact.execute).toHaveBeenCalledWith(
        TENANT_ID,
        'phone',
        '+15551234567',
        CHANNEL_TYPE_B,
      );
    });

    it('links the new session to the contact', async () => {
      const input = createInput();
      await useCase.execute(input);

      expect(deps.linkSession.execute).toHaveBeenCalledWith(
        TENANT_ID,
        CONTACT_ID,
        SESSION_ID,
        CHANNEL_TYPE_B,
        CHANNEL_ID_B,
      );
    });

    it('returns contactId and linked status', async () => {
      const input = createInput();
      const result = await useCase.execute(input);

      expect(result.contactId).toBe(CONTACT_ID);
      expect(result.linked).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // resumeCrossChannel: true -> carries context from previous session
  // ---------------------------------------------------------------------------

  describe('resumeCrossChannel: true', () => {
    it('loads previous session context for the contact', async () => {
      const input = createInput({ resumeCrossChannel: true });
      await useCase.execute(input);

      expect(deps.loadPreviousSessionContext).toHaveBeenCalledWith(
        TENANT_ID,
        CONTACT_ID,
        SESSION_ID,
      );
    });

    it('returns previousContext from the loaded session', async () => {
      const input = createInput({ resumeCrossChannel: true });
      const result = await useCase.execute(input);

      expect(result.previousContext).toEqual(PREVIOUS_CONTEXT);
    });

    it('returns null previousContext when no previous session exists', async () => {
      deps = createMockDeps({
        loadPreviousSessionContext: vi.fn().mockResolvedValue(null),
      });
      useCase = new SwitchChannel(deps);

      const input = createInput({ resumeCrossChannel: true });
      const result = await useCase.execute(input);

      expect(result.previousContext).toBeNull();
      expect(result.contactId).toBe(CONTACT_ID);
      expect(result.linked).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // resumeCrossChannel: false -> creates fresh session, still links contact
  // ---------------------------------------------------------------------------

  describe('resumeCrossChannel: false', () => {
    it('does not load previous session context', async () => {
      const input = createInput({ resumeCrossChannel: false });
      await useCase.execute(input);

      expect(deps.loadPreviousSessionContext).not.toHaveBeenCalled();
    });

    it('still links session to contact', async () => {
      const input = createInput({ resumeCrossChannel: false });
      await useCase.execute(input);

      expect(deps.linkSession.execute).toHaveBeenCalledWith(
        TENANT_ID,
        CONTACT_ID,
        SESSION_ID,
        CHANNEL_TYPE_B,
        CHANNEL_ID_B,
      );
    });

    it('returns null previousContext with linked contact', async () => {
      const input = createInput({ resumeCrossChannel: false });
      const result = await useCase.execute(input);

      expect(result.contactId).toBe(CONTACT_ID);
      expect(result.previousContext).toBeNull();
      expect(result.linked).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Contact not found (tier < 2) -> no cross-channel, just create fresh
  // ---------------------------------------------------------------------------

  describe('identity tier below 2 (no cross-channel)', () => {
    it('does not resolve contact for tier 0', async () => {
      const input = createInput({ identityTier: 0 });
      const result = await useCase.execute(input);

      expect(deps.resolveOrCreateContact.execute).not.toHaveBeenCalled();
      expect(deps.linkSession.execute).not.toHaveBeenCalled();
      expect(result.contactId).toBeNull();
      expect(result.previousContext).toBeNull();
      expect(result.linked).toBe(false);
    });

    it('does not resolve contact for tier 1', async () => {
      const input = createInput({ identityTier: 1 });
      const result = await useCase.execute(input);

      expect(deps.resolveOrCreateContact.execute).not.toHaveBeenCalled();
      expect(deps.linkSession.execute).not.toHaveBeenCalled();
      expect(result.contactId).toBeNull();
      expect(result.previousContext).toBeNull();
      expect(result.linked).toBe(false);
    });

    it('does not load previous context for tier < 2 even with resumeCrossChannel true', async () => {
      const input = createInput({ identityTier: 1, resumeCrossChannel: true });
      const result = await useCase.execute(input);

      expect(deps.loadPreviousSessionContext).not.toHaveBeenCalled();
      expect(result.previousContext).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('skips context loading when loadPreviousSessionContext is not provided', async () => {
      deps = createMockDeps({ loadPreviousSessionContext: undefined });
      useCase = new SwitchChannel(deps);

      const input = createInput({ resumeCrossChannel: true });
      const result = await useCase.execute(input);

      expect(result.contactId).toBe(CONTACT_ID);
      expect(result.previousContext).toBeNull();
      expect(result.linked).toBe(true);
    });
  });
});
