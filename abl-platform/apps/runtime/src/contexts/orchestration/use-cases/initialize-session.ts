/**
 * InitializeSession Orchestrator
 *
 * Hot path that composes channel, identity, and contact use cases to
 * determine whether to resume or create a session, build CallerContext,
 * register resolution keys, and optionally link contacts.
 *
 * This use case does NOT create the session itself -- it returns an
 * InitializeSessionResult with all the data needed for the caller
 * (e.g. the runtime session manager) to create or resume the session.
 *
 * All dependencies are injected via constructor (port interfaces).
 */

import crypto from 'crypto';
import type {
  CallerContext,
  ChannelArtifactType,
  IdentityTier,
  VerificationMethod,
} from '@agent-platform/shared-auth';
import type { ChannelType } from '../../../channels/types.js';
import type { ContactContext } from '../../contact/domain/contact.js';
import {
  resolveProviderVerification,
  type ProviderVerificationStrength,
} from '../../../services/identity/provider-verification-policy.js';

// Types previously from the channel context — defined locally since the orchestrator
// only consumes these via port interfaces.

/** Identity artifact extracted from an inbound channel message. */
interface ArtifactExtraction {
  rawValue: string;
  artifactType: ChannelArtifactType;
  providerVerified: boolean;
}

/** Result of parsing/normalizing an inbound webhook or message. */
interface ReceiveInboundResult {
  message: { senderArtifact: ArtifactExtraction | null } | null;
  artifact: ArtifactExtraction | null;
  error?: { code: string; message: string };
}
import type { ResolveSessionResult } from '../../identity/use-cases/resolve-session.js';
import type { SessionResolutionKey } from '../../identity/domain/session-resolution-key.js';
import type { CallerContextInput } from '../../../services/identity/artifact-hasher.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default session resolution key TTL: 24 hours. */
const DEFAULT_RESOLUTION_KEY_TTL_MS = 86_400_000;

/** Minimum identity tier required for contact resolution. */
const CONTACT_RESOLUTION_MIN_TIER: IdentityTier = 2;

// =============================================================================
// PORT INTERFACES
// =============================================================================

/** Port for the ReceiveInboundMessage use case. */
interface ReceiveInboundPort {
  execute(
    channelType: ChannelType,
    raw: unknown,
    headers: Record<string, string>,
  ): ReceiveInboundResult;
}

/** Port for the ResolveSession use case. */
interface ResolveSessionPort {
  execute(tenantId: string, channelId: string, artifactHash: string): Promise<ResolveSessionResult>;
}

/** Port for the RegisterResolutionKey use case. */
interface RegisterResolutionKeyPort {
  execute(key: SessionResolutionKey): Promise<void>;
}

/** Port for the ResolveOrCreateContact use case (optional, from contact context). */
interface ResolveOrCreateContactPort {
  execute(
    tenantId: string,
    identityType: string,
    identityValue: string,
    channelType?: string,
  ): Promise<{ contact: { id: string } }>;
}

/** Port for the LinkSessionToContact use case (optional, from contact context). */
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

export interface InitializeSessionDeps {
  readonly receiveInbound: ReceiveInboundPort;
  readonly resolveSession: ResolveSessionPort;
  readonly registerResolutionKey: RegisterResolutionKeyPort;
  readonly resolveOrCreateContact?: ResolveOrCreateContactPort;
  readonly linkSessionToContact?: LinkSessionPort;
  readonly hashArtifact: (rawValue: string) => string;
  readonly buildCallerContext: (input: CallerContextInput) => CallerContext;
  /** Optional: load cross-session contact context for pre-population (tier 2+ only). */
  readonly loadContactContext?: (
    tenantId: string,
    contactId: string,
  ) => Promise<ContactContext | null>;
  /** Optional: called when loadContactContext fails (fire-and-forget logging). */
  readonly onContactContextError?: (error: string, tenantId: string, contactId: string) => void;
}

export interface InitializeSessionInput {
  tenantId: string;
  channelType: ChannelType;
  channelId: string;
  rawPayload: unknown;
  headers: Record<string, string>;
  /** Pre-generated session ID for new sessions (caller creates the ID). */
  newSessionId: string;
  identityTier: IdentityTier;
  verificationMethod: VerificationMethod;
  /** Optional trusted policy override for provider-verified channel artifacts. */
  providerVerificationStrength?: ProviderVerificationStrength;
}

export interface InitializeSessionResult {
  resolution: 'resume' | 'create';
  sessionId?: string;
  callerContext: CallerContext;
  contactId?: string;
  artifact?: { hash: string; type: ChannelArtifactType };
  /** Unique session principal ID (UUIDv7) for omnichannel tracking */
  sessionPrincipalId?: string;
}

// =============================================================================
// USE CASE
// =============================================================================

export class InitializeSession {
  constructor(private readonly deps: InitializeSessionDeps) {}

  async execute(input: InitializeSessionInput): Promise<InitializeSessionResult> {
    // 1. Normalize inbound message and extract artifact
    const inbound = this.deps.receiveInbound.execute(
      input.channelType,
      input.rawPayload,
      input.headers,
    );

    if (!inbound.message || inbound.error) {
      throw new Error(inbound.error?.code ?? 'INBOUND_FAILED');
    }

    if (!inbound.artifact) {
      throw new Error('NO_ARTIFACT');
    }

    const artifact = inbound.artifact;
    const providerVerification = resolveProviderVerification({
      providerVerified: artifact.providerVerified,
      configuredStrength: input.providerVerificationStrength,
    });
    const effectiveIdentityTier = Math.max(
      input.identityTier,
      providerVerification.identityTier,
    ) as IdentityTier;
    const effectiveVerificationMethod =
      providerVerification.providerVerified &&
      providerVerification.identityTier > input.identityTier
        ? 'provider'
        : input.verificationMethod;

    // 2. Hash the artifact for resolution lookup
    const artifactHash = this.deps.hashArtifact(artifact.rawValue);

    // 3. Attempt to resolve an existing session
    const resolution = await this.deps.resolveSession.execute(
      input.tenantId,
      input.channelId,
      artifactHash,
    );

    // 4. Build CallerContext from artifact and the strongest trusted identity tier
    const callerContext = this.deps.buildCallerContext({
      tenantId: input.tenantId,
      channel: input.channelType,
      channelId: input.channelId,
      identityTier: effectiveIdentityTier,
      verificationMethod: effectiveVerificationMethod,
      rawArtifact: artifact.rawValue,
      channelArtifactType: artifact.artifactType,
    });

    // 5. Determine the effective session ID for contact linking
    const effectiveSessionId = resolution.found ? resolution.sessionId : input.newSessionId;

    // 6. Register resolution key for new sessions only
    if (!resolution.found) {
      await this.deps.registerResolutionKey.execute({
        tenantId: input.tenantId,
        channelId: input.channelId,
        artifactHash,
        sessionId: input.newSessionId,
        expiresAt: new Date(Date.now() + DEFAULT_RESOLUTION_KEY_TTL_MS),
      });
    }

    // 7. Contact resolution for verified identities (tier >= 2 or same-channel provider exception)
    let contactId: string | undefined;
    const shouldResolveContact =
      (effectiveIdentityTier >= CONTACT_RESOLUTION_MIN_TIER || artifact.providerVerified) &&
      this.deps.resolveOrCreateContact != null &&
      this.deps.linkSessionToContact != null;

    if (shouldResolveContact) {
      const { contact } = await this.deps.resolveOrCreateContact!.execute(
        input.tenantId,
        artifact.artifactType,
        artifact.rawValue,
        input.channelType,
      );
      contactId = contact.id;

      await this.deps.linkSessionToContact!.execute(
        input.tenantId,
        contactId,
        effectiveSessionId,
        input.channelType,
        input.channelId,
      );
    }

    // 8. Pre-populate callerContext with cross-session contact context (tier 2+ only)
    if (contactId && this.deps.loadContactContext) {
      try {
        const contactCtx = await this.deps.loadContactContext(input.tenantId, contactId);
        if (contactCtx) {
          callerContext.contactContext = contactCtx.dataValues;
          callerContext.contactPreferences = contactCtx.preferences;
        }
      } catch (err) {
        // Non-fatal: session continues without cross-session context
        this.deps.onContactContextError?.(
          err instanceof Error ? err.message : String(err),
          input.tenantId,
          contactId,
        );
      }
    }

    // Generate a unique session principal ID for new sessions and keep the
    // legacy anonymousId alias synchronized for compatibility callers.
    const sessionPrincipalId =
      callerContext.sessionPrincipalId ??
      callerContext.anonymousId ??
      (resolution.found ? undefined : crypto.randomUUID());

    if (sessionPrincipalId) {
      callerContext.sessionPrincipalId = sessionPrincipalId;
      callerContext.anonymousId ??= sessionPrincipalId;
    }

    return {
      resolution: resolution.found ? 'resume' : 'create',
      sessionId: resolution.found ? resolution.sessionId : undefined,
      callerContext,
      contactId,
      artifact: { hash: artifactHash, type: artifact.artifactType },
      sessionPrincipalId,
    };
  }
}
