/**
 * SwitchChannel Orchestrator
 *
 * Handles cross-channel continuity when a verified user (tier >= 2) appears
 * on a new channel. Resolves or creates a Contact, optionally loads context
 * from a previous session on a different channel, and links the new session
 * to the Contact.
 *
 * Users below tier 2 are not eligible for cross-channel resolution --
 * the orchestrator returns an unlinked result immediately.
 *
 * Dependencies are injected via constructor (port interfaces).
 */

import type { IdentityTier } from '@agent-platform/shared-auth';
import type { ChannelType } from '../../../channels/types.js';
import type { Contact } from '../../contact/domain/contact.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Minimum identity tier required for cross-channel contact resolution. */
const CROSS_CHANNEL_MIN_TIER: IdentityTier = 2;

// =============================================================================
// PORT INTERFACES
// =============================================================================

/** Port for the ResolveOrCreateContact use case (from contact context). */
interface ResolveOrCreateContactPort {
  execute(
    tenantId: string,
    identityType: string,
    identityValue: string,
    channelType?: string,
  ): Promise<{ contact: Contact }>;
}

/** Port for the LinkSessionToContact use case (from contact context). */
interface LinkSessionPort {
  execute(
    tenantId: string,
    contactId: string,
    sessionId: string,
    channelType: ChannelType,
    channelId: string,
  ): Promise<void>;
}

// =============================================================================
// TYPES
// =============================================================================

export interface SwitchChannelDeps {
  readonly resolveOrCreateContact: ResolveOrCreateContactPort;
  readonly linkSession: LinkSessionPort;
  readonly loadPreviousSessionContext?: (
    tenantId: string,
    contactId: string,
    excludeSessionId?: string,
  ) => Promise<Record<string, unknown> | null>;
}

export interface SwitchChannelInput {
  tenantId: string;
  sessionId: string;
  identityType: string;
  identityValue: string;
  channelType: ChannelType;
  channelId: string;
  identityTier: IdentityTier;
  resumeCrossChannel: boolean;
}

export interface SwitchChannelResult {
  contactId: string | null;
  previousContext: Record<string, unknown> | null;
  linked: boolean;
}

// =============================================================================
// USE CASE
// =============================================================================

export class SwitchChannel {
  constructor(private readonly deps: SwitchChannelDeps) {}

  async execute(input: SwitchChannelInput): Promise<SwitchChannelResult> {
    // 1. Only verified users (tier >= 2) are eligible for cross-channel
    if (input.identityTier < CROSS_CHANNEL_MIN_TIER) {
      return { contactId: null, previousContext: null, linked: false };
    }

    // 2. Resolve or create the contact from the identity
    const { contact } = await this.deps.resolveOrCreateContact.execute(
      input.tenantId,
      input.identityType,
      input.identityValue,
      input.channelType,
    );

    // 3. Optionally load context from a previous session on another channel
    let previousContext: Record<string, unknown> | null = null;
    if (input.resumeCrossChannel && this.deps.loadPreviousSessionContext != null) {
      previousContext = await this.deps.loadPreviousSessionContext(
        input.tenantId,
        contact.id,
        input.sessionId,
      );
    }

    // 4. Link the new session to the contact
    await this.deps.linkSession.execute(
      input.tenantId,
      contact.id,
      input.sessionId,
      input.channelType,
      input.channelId,
    );

    return { contactId: contact.id, previousContext, linked: true };
  }
}
