import type {
  CallerContext,
  ChannelArtifactType,
  IdentityTier,
  VerificationMethod,
} from '@agent-platform/shared-auth';
import type {
  IdentityEvidenceArtifactType,
  ProductionExecutionScope,
  ServicePrincipalType,
} from './execution-scope.js';
import { ScopeValidationError } from './scope-policy.js';

export interface ContactProductionExecutionScopeInput {
  tenantId?: string;
  projectId?: string;
  sessionId?: string;
  sessionPrincipalId?: string;
  channelId?: string;
  environment?: string;
  source: string;
  authType?: string;
  traceId?: string;
  contactId?: string;
  callerContext?: CallerContext | Record<string, unknown>;
  identityTier?: IdentityTier;
  verificationMethod?: VerificationMethod | string;
  channelArtifact?: string;
  channelArtifactType?: ChannelArtifactType;
}

export interface CanonicalContactScopeRequirementInput {
  authScope?: string;
  verifiedUserId?: string;
  contactId?: string;
  identityTier?: IdentityTier;
  verificationMethod?: VerificationMethod | string;
}

export interface ServicePrincipalProductionExecutionScopeInput {
  tenantId?: string;
  projectId?: string;
  sessionId?: string;
  sessionPrincipalId?: string;
  channelId?: string;
  environment?: string;
  source: string;
  authType?: string;
  traceId?: string;
  principalType?: ServicePrincipalType;
  principalId?: string;
  callerContext?: Record<string, unknown>;
  verificationMethod?: VerificationMethod | string;
}

export function resolveIdentityEvidenceArtifactType(
  channelArtifactType?: ChannelArtifactType,
): IdentityEvidenceArtifactType {
  switch (channelArtifactType) {
    case 'phone':
      return 'phone';
    case 'caller_id':
      return 'caller_id';
    case 'cookie':
      return 'cookie';
    case 'device_id':
      return 'device_id';
    case 'email_thread':
      return 'email';
    default:
      return 'external';
  }
}

export function buildContactProductionExecutionScope(
  input: ContactProductionExecutionScopeInput,
): ProductionExecutionScope | null {
  const {
    tenantId,
    projectId,
    sessionId,
    channelId,
    environment,
    source,
    authType,
    traceId,
    contactId,
    callerContext,
  } = input;
  const sessionPrincipalId =
    input.sessionPrincipalId ?? extractSessionPrincipalId(callerContext) ?? sessionId;

  if (
    !tenantId ||
    !projectId ||
    !sessionId ||
    !channelId ||
    !environment ||
    !authType ||
    !traceId ||
    !contactId ||
    !sessionPrincipalId
  ) {
    return null;
  }

  const identityTier = input.identityTier ?? extractIdentityTier(callerContext);
  const verificationMethod = input.verificationMethod ?? extractVerificationMethod(callerContext);

  if (identityTier === undefined || verificationMethod === undefined) {
    return null;
  }

  const artifactHash = input.channelArtifact ?? extractChannelArtifact(callerContext);
  const artifactType = input.channelArtifactType ?? extractChannelArtifactType(callerContext);

  return {
    kind: 'production',
    tenantId,
    projectId,
    sessionId,
    sessionPrincipalId,
    channelId,
    environment,
    source,
    authType,
    traceId,
    actor: { kind: 'contact', contactId },
    subject: { kind: 'contact', contactId },
    identityEvidence: {
      identityTier,
      verificationMethod,
      artifacts: artifactHash
        ? [{ type: resolveIdentityEvidenceArtifactType(artifactType), valueHash: artifactHash }]
        : [],
    },
    callerContext: {
      ...(callerContext ?? {}),
      sessionPrincipalId,
      ...(callerContext?.anonymousId ? {} : { anonymousId: sessionPrincipalId }),
    },
  };
}

export function requiresCanonicalContactProductionScope(
  input: CanonicalContactScopeRequirementInput,
): boolean {
  if (typeof input.contactId === 'string' && input.contactId.length > 0) {
    return true;
  }

  if (input.authScope === 'user') {
    return true;
  }

  if (typeof input.verifiedUserId === 'string' && input.verifiedUserId.length > 0) {
    return true;
  }

  if (input.identityTier !== undefined) {
    return true;
  }

  if (input.verificationMethod !== undefined) {
    return true;
  }

  return false;
}

export function buildRequiredContactProductionExecutionScope(
  input: ContactProductionExecutionScopeInput,
): ProductionExecutionScope {
  const scope = buildContactProductionExecutionScope(input);
  if (scope) {
    return scope;
  }

  const missingFields = collectMissingContactScopeFields(input);
  throw new ScopeValidationError('INVALID_SESSION_SCOPE', 'Invalid production session scope.', {
    field: missingFields[0] ?? 'scope',
    reason: 'incomplete_contact_production_scope',
    received: { missingFields },
  });
}

export function buildServicePrincipalProductionExecutionScope(
  input: ServicePrincipalProductionExecutionScopeInput,
): ProductionExecutionScope | null {
  const {
    tenantId,
    projectId,
    sessionId,
    channelId,
    environment,
    source,
    authType,
    traceId,
    principalType,
    principalId,
    callerContext,
  } = input;
  const sessionPrincipalId = input.sessionPrincipalId ?? principalId ?? sessionId;

  if (
    !tenantId ||
    !projectId ||
    !sessionId ||
    !channelId ||
    !environment ||
    !authType ||
    !traceId ||
    !principalType ||
    !principalId ||
    !sessionPrincipalId
  ) {
    return null;
  }

  return {
    kind: 'production',
    tenantId,
    projectId,
    sessionId,
    sessionPrincipalId,
    channelId,
    environment,
    source,
    authType,
    traceId,
    actor: {
      kind: 'service_principal',
      principalType,
      principalId,
    },
    subject: {
      kind: 'service_principal',
      principalType,
      principalId,
    },
    identityEvidence: {
      identityTier: 2,
      verificationMethod: input.verificationMethod ?? 'provider',
      artifacts: [],
    },
    callerContext: { ...(callerContext ?? {}), sessionPrincipalId },
  };
}

export function buildRequiredServicePrincipalProductionExecutionScope(
  input: ServicePrincipalProductionExecutionScopeInput,
): ProductionExecutionScope {
  const scope = buildServicePrincipalProductionExecutionScope(input);
  if (scope) {
    return scope;
  }

  const missingFields = collectMissingServicePrincipalScopeFields(input);
  throw new ScopeValidationError('INVALID_SESSION_SCOPE', 'Invalid production session scope.', {
    field: missingFields[0] ?? 'scope',
    reason: 'incomplete_service_principal_production_scope',
    received: { missingFields },
  });
}

function collectMissingContactScopeFields(input: ContactProductionExecutionScopeInput): string[] {
  const missingFields: string[] = [];

  if (!input.tenantId) {
    missingFields.push('tenantId');
  }
  if (!input.projectId) {
    missingFields.push('projectId');
  }
  if (!input.sessionId) {
    missingFields.push('sessionId');
  }
  if (
    !input.sessionPrincipalId &&
    !extractSessionPrincipalId(input.callerContext) &&
    !input.sessionId
  ) {
    missingFields.push('sessionPrincipalId');
  }
  if (!input.channelId) {
    missingFields.push('channelId');
  }
  if (!input.environment) {
    missingFields.push('environment');
  }
  if (!input.authType) {
    missingFields.push('authType');
  }
  if (!input.traceId) {
    missingFields.push('traceId');
  }
  if (!input.contactId) {
    missingFields.push('subject.contactId');
  }

  const identityTier = input.identityTier ?? extractIdentityTier(input.callerContext);
  if (identityTier === undefined) {
    missingFields.push('identityEvidence.identityTier');
  }

  const verificationMethod =
    input.verificationMethod ?? extractVerificationMethod(input.callerContext);
  if (verificationMethod === undefined) {
    missingFields.push('identityEvidence.verificationMethod');
  }

  return missingFields;
}

function collectMissingServicePrincipalScopeFields(
  input: ServicePrincipalProductionExecutionScopeInput,
): string[] {
  const missingFields: string[] = [];

  if (!input.tenantId) {
    missingFields.push('tenantId');
  }
  if (!input.projectId) {
    missingFields.push('projectId');
  }
  if (!input.sessionId) {
    missingFields.push('sessionId');
  }
  if (!input.sessionPrincipalId && !input.principalId && !input.sessionId) {
    missingFields.push('sessionPrincipalId');
  }
  if (!input.channelId) {
    missingFields.push('channelId');
  }
  if (!input.environment) {
    missingFields.push('environment');
  }
  if (!input.authType) {
    missingFields.push('authType');
  }
  if (!input.traceId) {
    missingFields.push('traceId');
  }
  if (!input.principalType) {
    missingFields.push('subject.principalType');
  }
  if (!input.principalId) {
    missingFields.push('subject.principalId');
  }

  return missingFields;
}

function extractIdentityTier(
  callerContext: ContactProductionExecutionScopeInput['callerContext'],
): IdentityTier | undefined {
  if (
    callerContext &&
    'identityTier' in callerContext &&
    typeof callerContext.identityTier === 'number'
  ) {
    return callerContext.identityTier as IdentityTier;
  }

  return undefined;
}

function extractVerificationMethod(
  callerContext: ContactProductionExecutionScopeInput['callerContext'],
): VerificationMethod | string | undefined {
  if (
    callerContext &&
    'verificationMethod' in callerContext &&
    typeof callerContext.verificationMethod === 'string'
  ) {
    return callerContext.verificationMethod;
  }

  return undefined;
}

function extractChannelArtifact(
  callerContext: ContactProductionExecutionScopeInput['callerContext'],
): string | undefined {
  if (
    callerContext &&
    'channelArtifact' in callerContext &&
    typeof callerContext.channelArtifact === 'string' &&
    callerContext.channelArtifact.length > 0
  ) {
    return callerContext.channelArtifact;
  }

  return undefined;
}

function extractChannelArtifactType(
  callerContext: ContactProductionExecutionScopeInput['callerContext'],
): ChannelArtifactType | undefined {
  if (
    callerContext &&
    'channelArtifactType' in callerContext &&
    typeof callerContext.channelArtifactType === 'string'
  ) {
    return callerContext.channelArtifactType as ChannelArtifactType;
  }

  return undefined;
}

function extractSessionPrincipalId(
  callerContext: ContactProductionExecutionScopeInput['callerContext'],
): string | undefined {
  if (
    callerContext &&
    'sessionPrincipalId' in callerContext &&
    typeof callerContext.sessionPrincipalId === 'string' &&
    callerContext.sessionPrincipalId.length > 0
  ) {
    return callerContext.sessionPrincipalId;
  }

  if (
    callerContext &&
    'anonymousId' in callerContext &&
    typeof callerContext.anonymousId === 'string' &&
    callerContext.anonymousId.length > 0
  ) {
    return callerContext.anonymousId;
  }

  return undefined;
}
