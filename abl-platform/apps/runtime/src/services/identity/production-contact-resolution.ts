import { createLogger } from '@abl/compiler/platform';
import type { CallerContext } from '@agent-platform/shared-auth';
import type { ContactLinkingDeps } from './contact-linking-deps.js';

const log = createLogger('production-contact-resolution');

type ContactIdentityType = 'email' | 'phone' | 'external';
type ContactAuditSource = 'customer_id' | 'channel_artifact' | 'session_principal' | 'anonymous_id';

interface IdentityCandidate {
  identityType: ContactIdentityType;
  identityValue: string;
  auditSource: ContactAuditSource;
}

export interface ProductionContactResolutionInput {
  tenantId?: string;
  callerContext?: CallerContext;
  channelType?: string;
  sessionId?: string;
}

export interface ProductionContactResolutionResult {
  contactId: string;
  displayName: string | null;
}

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function inferAnonymousIdentityType(callerContext: CallerContext): ContactIdentityType {
  if (callerContext.channelArtifactType === 'email_thread') {
    return 'email';
  }

  if (
    callerContext.channelArtifactType === 'caller_id' ||
    callerContext.channelArtifactType === 'phone'
  ) {
    return 'phone';
  }

  if (hasValue(callerContext.anonymousId)) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(callerContext.anonymousId)) {
      return 'email';
    }

    if (/^\+?\d[\d\s\-().]{6,}$/.test(callerContext.anonymousId)) {
      return 'phone';
    }
  }

  return 'external';
}

function inferArtifactIdentityType(
  callerContext: CallerContext,
  artifactValue: string,
): ContactIdentityType {
  if (callerContext.channelArtifactType === 'email_thread') {
    return 'email';
  }

  if (
    callerContext.channelArtifactType === 'caller_id' ||
    callerContext.channelArtifactType === 'phone'
  ) {
    return 'phone';
  }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(artifactValue)) {
    return 'email';
  }

  if (/^\+?\d[\d\s\-().]{6,}$/.test(artifactValue)) {
    return 'phone';
  }

  return 'external';
}

function inferIdentityCandidate(callerContext: CallerContext): IdentityCandidate | null {
  if (hasValue(callerContext.customerId)) {
    return {
      identityType: 'external',
      identityValue: callerContext.customerId,
      auditSource: 'customer_id',
    };
  }

  if (hasValue(callerContext.channelArtifact)) {
    return {
      identityType: inferArtifactIdentityType(callerContext, callerContext.channelArtifact),
      identityValue: callerContext.channelArtifact,
      auditSource: 'channel_artifact',
    };
  }

  if (hasValue(callerContext.sessionPrincipalId)) {
    return {
      identityType: 'external',
      identityValue: callerContext.sessionPrincipalId,
      auditSource: 'session_principal',
    };
  }

  if (hasValue(callerContext.anonymousId)) {
    return {
      identityType: inferAnonymousIdentityType(callerContext),
      identityValue: callerContext.anonymousId,
      auditSource: 'anonymous_id',
    };
  }

  return null;
}

export async function resolveCanonicalContactForProductionScope(
  input: ProductionContactResolutionInput,
  deps: ContactLinkingDeps,
): Promise<ProductionContactResolutionResult | undefined> {
  if (!input.tenantId || !input.callerContext) {
    return undefined;
  }

  if (hasValue(input.callerContext.contactId)) {
    return {
      contactId: input.callerContext.contactId,
      displayName:
        typeof input.callerContext.contactDisplayName === 'string'
          ? input.callerContext.contactDisplayName
          : null,
    };
  }

  const candidate = inferIdentityCandidate(input.callerContext);
  if (!candidate) {
    return undefined;
  }

  try {
    const contact = await deps.resolveOrCreateContact.execute(
      input.tenantId,
      candidate.identityType,
      candidate.identityValue,
      input.channelType ?? input.callerContext.channel,
      {
        contactAuditSource: candidate.auditSource,
        suppressContactCreatedAudit:
          candidate.auditSource === 'anonymous_id' || candidate.auditSource === 'session_principal',
      },
    );

    log.info('Resolved canonical contact for production scope', {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      channelType: input.channelType ?? input.callerContext.channel,
      identityType: candidate.identityType,
      contactId: contact.id,
    });

    return {
      contactId: contact.id,
      displayName: contact.displayName,
    };
  } catch (err) {
    log.warn('Failed to resolve canonical contact for production scope', {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      channelType: input.channelType ?? input.callerContext.channel,
      identityTier: input.callerContext.identityTier,
      verificationMethod: input.callerContext.verificationMethod,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
