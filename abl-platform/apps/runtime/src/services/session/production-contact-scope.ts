import { randomUUID } from 'node:crypto';
import type { CallerContext } from '@agent-platform/shared-auth';
import {
  getContactLinkingDeps,
  type ContactLinkingDeps,
} from '../identity/contact-linking-deps.js';
import { resolveCanonicalContactForProductionScope } from '../identity/production-contact-resolution.js';
import type { ProductionExecutionScope } from './execution-scope.js';
import { buildRequiredContactProductionExecutionScope } from './execution-scope-factory.js';
import { ScopeValidationError } from './scope-policy.js';

export interface ResolveRequiredContactProductionScopeParams {
  tenantId?: string;
  projectId?: string;
  sessionId?: string;
  channelId?: string;
  environment?: string;
  source: string;
  authType: string;
  callerContext?: CallerContext;
  channelType?: string;
  traceId?: string;
  fallbackAnonymousId?: string;
  deps?: ContactLinkingDeps | null;
}

function hasIdentityCandidate(callerContext: CallerContext | undefined): boolean {
  return (
    !!callerContext?.contactId ||
    !!callerContext?.customerId ||
    !!callerContext?.channelArtifact ||
    !!callerContext?.sessionPrincipalId ||
    !!callerContext?.anonymousId
  );
}

function withFallbackAnonymousId(
  callerContext: CallerContext | undefined,
  fallbackAnonymousId: string | undefined,
): CallerContext | undefined {
  if (
    !callerContext ||
    (callerContext.anonymousId && callerContext.sessionPrincipalId) ||
    !fallbackAnonymousId
  ) {
    return callerContext;
  }

  return {
    ...callerContext,
    anonymousId: callerContext.anonymousId ?? fallbackAnonymousId,
    sessionPrincipalId: callerContext.sessionPrincipalId ?? fallbackAnonymousId,
  };
}

export async function resolveRequiredContactProductionScope(
  params: ResolveRequiredContactProductionScopeParams,
): Promise<{
  callerContext: CallerContext;
  scope: ProductionExecutionScope;
}> {
  const callerContext = withFallbackAnonymousId(params.callerContext, params.fallbackAnonymousId);
  if (!callerContext) {
    throw new ScopeValidationError('INVALID_SESSION_SCOPE', 'Invalid production session scope.', {
      field: 'callerContext',
      reason: 'missing_caller_context',
    });
  }

  if (!hasIdentityCandidate(callerContext)) {
    throw new ScopeValidationError('INVALID_SESSION_SCOPE', 'Invalid production session scope.', {
      field: 'subject.contactId',
      reason: 'missing_identity_candidate',
    });
  }

  let resolvedCallerContext = callerContext;
  if (!resolvedCallerContext.contactId) {
    const deps = params.deps ?? getContactLinkingDeps();
    if (!deps) {
      throw new ScopeValidationError('INVALID_SESSION_SCOPE', 'Invalid production session scope.', {
        field: 'subject.contactId',
        reason: 'contact_resolution_unavailable',
      });
    }

    const resolvedContact = await resolveCanonicalContactForProductionScope(
      {
        tenantId: params.tenantId,
        callerContext: resolvedCallerContext,
        channelType: params.channelType ?? resolvedCallerContext.channel,
        sessionId: params.sessionId,
      },
      deps,
    );

    if (!resolvedContact) {
      throw new ScopeValidationError('INVALID_SESSION_SCOPE', 'Invalid production session scope.', {
        field: 'subject.contactId',
        reason: 'contact_resolution_failed',
      });
    }

    resolvedCallerContext = {
      ...resolvedCallerContext,
      contactId: resolvedContact.contactId,
      ...(resolvedContact.displayName ? { contactDisplayName: resolvedContact.displayName } : {}),
    };
  }

  const scope = buildRequiredContactProductionExecutionScope({
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
    channelId: params.channelId ?? resolvedCallerContext.channelId,
    environment: params.environment,
    source: params.source,
    authType: params.authType,
    traceId: params.traceId ?? randomUUID(),
    sessionPrincipalId:
      resolvedCallerContext.sessionPrincipalId ?? resolvedCallerContext.anonymousId,
    contactId: resolvedCallerContext.contactId,
    callerContext: resolvedCallerContext,
    identityTier: resolvedCallerContext.identityTier,
    verificationMethod: resolvedCallerContext.verificationMethod,
    channelArtifact: resolvedCallerContext.channelArtifact,
    channelArtifactType: resolvedCallerContext.channelArtifactType,
  });

  return {
    callerContext: resolvedCallerContext,
    scope,
  };
}
