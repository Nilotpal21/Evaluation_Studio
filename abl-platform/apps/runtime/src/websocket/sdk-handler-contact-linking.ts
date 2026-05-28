/**
 * SDK Handler Contact Linking
 *
 * Extracted helper for resolving and linking contacts during SDK session
 * initialization. This module is separated from sdk-handler.ts for testability --
 * it has no WebSocket, Redis, or other infrastructure dependencies.
 *
 * The helpers in this module resolve a verified SDK caller into a canonical
 * contact subject and, when requested, link the session to that contact.
 * Errors are caught and logged -- contact operations must never block session
 * initialization.
 */

import type { CallerContext } from '@agent-platform/shared-auth';
import type { ChannelType } from '../channels/types.js';
import { createLogger } from '@abl/compiler/platform';
import type { ContactLinkingDeps } from '../services/identity/contact-linking-deps.js';
import { resolveCanonicalContactForProductionScope } from '../services/identity/production-contact-resolution.js';
export type { ContactLinkingDeps } from '../services/identity/contact-linking-deps.js';

const log = createLogger('sdk-contact-linking');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default channel type for SDK WebSocket sessions. */
const SDK_CHANNEL_TYPE: ChannelType = 'sdk_websocket';

// =============================================================================
// TYPES
// =============================================================================

/** Minimal state required from SDKClientState for contact linking. */
export interface ContactLinkingState {
  tenantId?: string;
  channelId?: string;
  callerContext?: CallerContext;
  sessionId: string;
}

// =============================================================================
// HELPER
// =============================================================================

/** Result returned by resolveAndLinkContact with contact metadata. */
export interface ContactLinkingResult {
  contactId: string;
  displayName: string | null;
}

/**
 * Resolve or create a canonical contact for a human SDK caller, then link the session.
 *
 * Returns the contactId and displayName if successfully resolved, undefined otherwise.
 * Errors are caught and logged -- this must never block session initialization.
 *
 * @param state  - Minimal SDK client state (tenantId, channelId, callerContext)
 * @param sessionId - The session ID to link to the contact
 * @param deps   - Injected use case ports (for testability)
 */
export async function resolveContactForProductionScope(
  state: ContactLinkingState,
  deps: ContactLinkingDeps,
): Promise<ContactLinkingResult | undefined> {
  return resolveCanonicalContactForProductionScope(
    {
      tenantId: state.tenantId,
      callerContext: state.callerContext,
      channelType: state.callerContext?.channel,
      sessionId: state.sessionId,
    },
    deps,
  );
}

export async function resolveAndLinkContact(
  state: ContactLinkingState,
  sessionId: string,
  deps: ContactLinkingDeps,
): Promise<ContactLinkingResult | undefined> {
  const result = await resolveContactForProductionScope(state, deps);
  if (!result || !state.tenantId) {
    return result;
  }

  const channelId = state.channelId ?? state.callerContext?.channelId ?? '';

  // Link session to contact (best-effort -- don't fail if this errors)
  try {
    await deps.linkSessionToContact.execute(
      state.tenantId,
      result.contactId,
      sessionId,
      SDK_CHANNEL_TYPE,
      channelId,
    );
  } catch (linkErr) {
    log.warn('Failed to link session to contact', {
      error: linkErr instanceof Error ? linkErr.message : String(linkErr),
      contactId: result.contactId,
      sessionId,
    });
  }

  return result;
}
