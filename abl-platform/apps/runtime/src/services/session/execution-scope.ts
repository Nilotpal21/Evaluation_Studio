import type { AuthType, VerificationMethod } from '@agent-platform/shared-auth';

export type ServicePrincipalType = 'workflow' | 'agent' | 'integration';
export const SERVICE_PRINCIPAL_TYPES = ['workflow', 'agent', 'integration'] as const;

export type IdentityEvidenceArtifactType =
  | 'external'
  | 'phone'
  | 'email'
  | 'cookie'
  | 'caller_id'
  | 'device_id';
export const IDENTITY_EVIDENCE_ARTIFACT_TYPES = [
  'external',
  'phone',
  'email',
  'cookie',
  'caller_id',
  'device_id',
] as const;

export interface IdentityEvidenceArtifact {
  type: IdentityEvidenceArtifactType;
  valueHash: string;
}

export interface IdentityEvidence {
  identityTier: 0 | 1 | 2;
  verificationMethod: VerificationMethod | string;
  artifacts: IdentityEvidenceArtifact[];
}

export type SessionSubject =
  | { kind: 'contact'; contactId: string }
  | {
      kind: 'service_principal';
      principalType: ServicePrincipalType;
      principalId: string;
    };

export type SessionActor =
  | { kind: 'contact'; contactId: string }
  | { kind: 'platform_user'; userId: string }
  | { kind: 'api_key'; keyId: string }
  | {
      kind: 'service_principal';
      principalType: ServicePrincipalType;
      principalId: string;
    };

export interface ProductionExecutionScope {
  kind: 'production';
  tenantId: string;
  projectId: string;
  sessionId: string;
  sessionPrincipalId: string;
  channelId: string;
  environment: string;
  source: string;
  authType: AuthType | string;
  traceId: string;
  actor: SessionActor;
  subject: SessionSubject;
  identityEvidence: IdentityEvidence;
  callerContext: Record<string, unknown>;
}

export interface DebugExecutionScope {
  kind: 'debug';
  tenantId: string;
  projectId: string;
  sessionId: string;
  actor: Exclude<SessionActor, { kind: 'contact' }>;
  source: string;
  traceId: string;
  callerData?: Record<string, unknown>;
}

export interface SystemExecutionScope {
  kind: 'system';
  tenantId: string;
  projectId?: string;
  sessionId: string;
  actor: Extract<SessionActor, { kind: 'service_principal' }>;
  source: string;
  traceId: string;
  operation: string;
}

export type ExecutionScope = ProductionExecutionScope | DebugExecutionScope | SystemExecutionScope;

export type SessionScope = Pick<
  ProductionExecutionScope,
  'kind' | 'tenantId' | 'projectId' | 'sessionId' | 'sessionPrincipalId' | 'actor' | 'subject'
>;

export interface SessionLocator {
  kind: ExecutionScope['kind'];
  tenantId: string;
  projectId?: string;
  sessionId: string;
  sessionPrincipalId?: string;
}

export interface PrivilegedSessionLocator {
  tenantId: string;
  sessionId: string;
  requestedProjectId?: string;
  accessReason: 'admin_investigation' | 'migration' | 'gdpr' | 'audit_replay';
  actor: Exclude<SessionActor, { kind: 'contact' }>;
  traceId: string;
  redactIdentities: boolean;
}

export interface ScopeDiagnostics {
  scopeKind: ExecutionScope['kind'];
  sessionLocator: SessionLocator | null;
  sessionPrincipalId: string | null;
  subject: { kind: SessionSubject['kind']; id: string } | null;
  actor: { kind: SessionActor['kind']; id: string };
  authType: AuthType | string | null;
  source: string | null;
  environment: string | null;
  identityEvidenceSummary: {
    identityTier: number | null;
    verificationMethod: VerificationMethod | string | null;
    artifactTypes: IdentityEvidenceArtifactType[];
  };
  migrationStatus: 'native' | 'backfilled' | 'compatibility' | 'quarantined';
  compatibilityPathUsed: string | null;
}

export function toSessionLocator(scope: ExecutionScope): SessionLocator {
  return {
    kind: scope.kind,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    ...(scope.kind === 'production' ? { sessionPrincipalId: scope.sessionPrincipalId } : {}),
  };
}

export function buildProductionSessionLocator(params: {
  tenantId?: string;
  projectId?: string;
  sessionId?: string;
  sessionPrincipalId?: string;
}): SessionLocator | null {
  if (!params.tenantId || !params.projectId || !params.sessionId) {
    return null;
  }

  return {
    kind: 'production',
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
    ...(params.sessionPrincipalId ? { sessionPrincipalId: params.sessionPrincipalId } : {}),
  };
}
