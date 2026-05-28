/**
 * PromoteAndLink Orchestrator
 *
 * Handles mid-session identity verification completing and linking to contacts.
 * Composes three use cases across bounded contexts:
 *
 * 1. PromoteTier (identity context) — validate tier promotion
 * 2. ResolveOrCreateContact (contact context) — find/create contact
 * 3. LinkSessionToContact (contact context) — link session to contact
 * 4. Enqueue back-link and merge detection jobs (via optional port)
 *
 * Flow (Section 8.2):
 *   VerificationAttempt completes
 *     -> PromoteTier(session, newTier, proof)
 *     -> ResolveOrCreateContact(tenantId, identity)
 *     -> LinkSessionToContact(session, contact)
 *     -> enqueue BackLinkSessions job
 *     -> enqueue DetectMergeCandidates job
 */

import type { IdentityTier, VerificationMethod } from '@agent-platform/shared-auth';
import type { ChannelType } from '../../../channels/types.js';
import type { Contact } from '../../contact/domain/contact.js';
import type { PromoteTierResult } from '../../identity/use-cases/promote-tier.js';
import type { SessionResolutionWriteInput } from '../../identity/domain/session-resolution-record.js';

// =============================================================================
// PORT INTERFACES
// =============================================================================

export interface PromoteAndLinkDeps {
  promoteTier: {
    execute(input: {
      currentTier: IdentityTier;
      verificationMethod: VerificationMethod;
      resolvedTier?: IdentityTier;
    }): PromoteTierResult;
  };
  resolveOrCreateContact: {
    execute(
      tenantId: string,
      identityType: string,
      identityValue: string,
      channelType?: string,
    ): Promise<{ contact: Contact }>;
  };
  linkSession: {
    execute(
      tenantId: string,
      contactId: string,
      sessionId: string,
      channelType: ChannelType,
      channelId: string,
    ): Promise<void>;
  };
  enqueueJob?: (jobName: string, data: Record<string, unknown>) => Promise<void>;
  backfillContactId?: (tenantId: string, sessionId: string, contactId: string) => Promise<void>;
  /** Update session's verifiedIdentity after tier 2 promotion */
  updateSessionVerifiedIdentity?: (
    tenantId: string,
    sessionId: string,
    verifiedIdentity: {
      contactId: string;
      method: string;
      strength: number;
      verifiedAt: Date;
    },
  ) => Promise<void>;
  registerResolutionKey?: {
    execute(record: SessionResolutionWriteInput): Promise<void>;
  };
  recordVerificationProvenance?: (event: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    sessionPrincipalId: string;
    verificationMethod: VerificationMethod;
    identityTier: IdentityTier;
    contactId: string;
    policySource: string;
    grantScope: string;
    traceId: string;
    verifiedAt: Date;
    verificationAttemptId?: string;
  }) => Promise<void>;
}

// =============================================================================
// INPUT / RESULT TYPES
// =============================================================================

export interface PromoteAndLinkInput {
  tenantId: string;
  projectId?: string;
  sessionId: string;
  sessionPrincipalId?: string;
  currentTier: IdentityTier;
  verificationMethod: VerificationMethod;
  verificationTier?: IdentityTier;
  verificationAttemptId?: string;
  identityType: string;
  identityValue: string;
  artifactHash?: string;
  channelType: ChannelType;
  channelId: string;
  policySource?: string;
  grantScope?: string;
  traceId?: string;
  verifiedAt?: Date;
}

export interface PromoteAndLinkResult {
  promoted: boolean;
  newTier?: IdentityTier;
  contactId?: string;
  error?: { code: string; message: string };
}

// =============================================================================
// USE CASE
// =============================================================================

export class PromoteAndLink {
  constructor(private readonly deps: PromoteAndLinkDeps) {}

  async execute(input: PromoteAndLinkInput): Promise<PromoteAndLinkResult> {
    // 1. Validate tier promotion
    const promotion = this.deps.promoteTier.execute({
      currentTier: input.currentTier,
      verificationMethod: input.verificationMethod,
      resolvedTier: input.verificationTier,
    });

    if (!promotion.success) {
      return { promoted: false, error: promotion.error };
    }

    // 2. Resolve or create contact
    const { contact } = await this.deps.resolveOrCreateContact.execute(
      input.tenantId,
      input.identityType,
      input.identityValue,
      input.channelType,
    );

    // 3. Link session to contact
    await this.deps.linkSession.execute(
      input.tenantId,
      contact.id,
      input.sessionId,
      input.channelType,
      input.channelId,
    );

    // 4. Backfill contactId on messages written before contact was known
    await this.deps.backfillContactId?.(input.tenantId, input.sessionId, contact.id);

    const verifiedAt = input.verifiedAt ?? new Date();
    const resolvedTier = promotion.newTier ?? 2;
    const sessionPrincipalId = input.sessionPrincipalId ?? input.sessionId;
    const policySource = input.policySource ?? 'promote_and_link';
    const grantScope = input.grantScope ?? (resolvedTier >= 2 ? 'user' : 'session');
    const traceId =
      input.traceId ?? `promote-and-link:${input.tenantId}:${input.sessionId}:${contact.id}`;

    // 5. Update session's verified identity for omnichannel tracking
    await this.deps.updateSessionVerifiedIdentity?.(input.tenantId, input.sessionId, {
      contactId: contact.id,
      method: input.verificationMethod,
      strength: resolvedTier,
      verifiedAt,
    });

    if (this.deps.registerResolutionKey && input.projectId && input.artifactHash) {
      await this.deps.registerResolutionKey.execute({
        tenantId: input.tenantId,
        projectId: input.projectId,
        channelId: input.channelId,
        artifactHash: input.artifactHash,
        sessionLocator: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          sessionId: input.sessionId,
        },
        sessionPrincipalId,
        verificationAttemptId: input.verificationAttemptId,
        verificationMethod: input.verificationMethod,
        identityTier: resolvedTier,
        policySource,
        grantScope,
        traceId,
        verifiedAt,
        expiresAt: new Date(verifiedAt.getTime() + 86_400_000),
      });
    }

    await this.deps.recordVerificationProvenance?.({
      tenantId: input.tenantId,
      projectId: input.projectId ?? '',
      sessionId: input.sessionId,
      sessionPrincipalId,
      verificationMethod: input.verificationMethod,
      identityTier: resolvedTier,
      contactId: contact.id,
      policySource,
      grantScope,
      traceId,
      verifiedAt,
      ...(input.verificationAttemptId
        ? { verificationAttemptId: input.verificationAttemptId }
        : {}),
    });

    // 6. Enqueue background jobs (if enqueueJob port is provided)
    if (this.deps.enqueueJob) {
      await this.deps.enqueueJob('BackLinkSessions', {
        tenantId: input.tenantId,
        contactId: contact.id,
        sessionId: input.sessionId,
      });

      await this.deps.enqueueJob('DetectMergeCandidates', {
        tenantId: input.tenantId,
        contactId: contact.id,
      });
    }

    return {
      promoted: true,
      newTier: promotion.newTier,
      contactId: contact.id,
    };
  }
}
