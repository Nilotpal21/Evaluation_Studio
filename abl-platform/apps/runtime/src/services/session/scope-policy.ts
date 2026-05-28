import type {
  IdentityEvidence,
  IdentityEvidenceArtifact,
  ProductionExecutionScope,
  SessionActor,
  SessionSubject,
} from './execution-scope.js';
import { IDENTITY_EVIDENCE_ARTIFACT_TYPES, SERVICE_PRINCIPAL_TYPES } from './execution-scope.js';

export type ScopeValidationCode = 'INVALID_SESSION_SCOPE' | 'UNSUPPORTED_SCOPE_KIND';

export interface ScopeValidationDetails {
  field: string;
  reason: string;
  received?: unknown;
}

export class ScopeValidationError extends Error {
  code: ScopeValidationCode;
  details: ScopeValidationDetails;

  constructor(code: ScopeValidationCode, message: string, details: ScopeValidationDetails) {
    super(message);
    this.name = 'ScopeValidationError';
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      `Session scope field "${field}" must be a non-empty string`,
      {
        field,
        reason: 'required_non_empty_string',
        received: value,
      },
    );
  }
}

function assertIdentityEvidenceArtifact(
  artifact: unknown,
  field: string,
): asserts artifact is IdentityEvidenceArtifact {
  if (!isRecord(artifact)) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      `Session scope field "${field}" must be an object`,
      {
        field,
        reason: 'required_object',
        received: artifact,
      },
    );
  }

  assertNonEmptyString(artifact.type, `${field}.type`);
  if (
    !IDENTITY_EVIDENCE_ARTIFACT_TYPES.includes(
      artifact.type as (typeof IDENTITY_EVIDENCE_ARTIFACT_TYPES)[number],
    )
  ) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      `Session scope field "${field}.type" is not a supported artifact type`,
      {
        field: `${field}.type`,
        reason: 'unsupported_artifact_type',
        received: artifact.type,
      },
    );
  }
  assertNonEmptyString(artifact.valueHash, `${field}.valueHash`);
}

function assertIdentityEvidence(
  evidence: unknown,
  field: string,
): asserts evidence is IdentityEvidence {
  if (!isRecord(evidence)) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      `Session scope field "${field}" must be an object`,
      {
        field,
        reason: 'required_object',
        received: evidence,
      },
    );
  }

  if (![0, 1, 2].includes(evidence.identityTier as number)) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      `Session scope field "${field}.identityTier" must be 0, 1, or 2`,
      {
        field: `${field}.identityTier`,
        reason: 'unsupported_identity_tier',
        received: evidence.identityTier,
      },
    );
  }

  assertNonEmptyString(evidence.verificationMethod, `${field}.verificationMethod`);

  if (!Array.isArray(evidence.artifacts)) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      `Session scope field "${field}.artifacts" must be an array`,
      {
        field: `${field}.artifacts`,
        reason: 'required_array',
        received: evidence.artifacts,
      },
    );
  }

  evidence.artifacts.forEach((artifact, index) =>
    assertIdentityEvidenceArtifact(artifact, `${field}.artifacts[${index}]`),
  );
}

function assertSessionSubject(subject: unknown, field: string): asserts subject is SessionSubject {
  if (!isRecord(subject)) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      `Session scope field "${field}" must be an object`,
      {
        field,
        reason: 'required_object',
        received: subject,
      },
    );
  }

  if (subject.kind === 'contact') {
    assertNonEmptyString(subject.contactId, `${field}.contactId`);
    return;
  }

  if (subject.kind === 'service_principal') {
    assertNonEmptyString(subject.principalType, `${field}.principalType`);
    if (
      !SERVICE_PRINCIPAL_TYPES.includes(
        subject.principalType as (typeof SERVICE_PRINCIPAL_TYPES)[number],
      )
    ) {
      throw new ScopeValidationError(
        'INVALID_SESSION_SCOPE',
        `Session scope field "${field}.principalType" is not supported`,
        {
          field: `${field}.principalType`,
          reason: 'unsupported_service_principal_type',
          received: subject.principalType,
        },
      );
    }
    assertNonEmptyString(subject.principalId, `${field}.principalId`);
    return;
  }

  throw new ScopeValidationError(
    'INVALID_SESSION_SCOPE',
    `Session scope field "${field}.kind" is not a supported subject kind`,
    {
      field: `${field}.kind`,
      reason: 'unsupported_subject_kind',
      received: subject.kind,
    },
  );
}

function assertSessionActor(actor: unknown, field: string): asserts actor is SessionActor {
  if (!isRecord(actor)) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      `Session scope field "${field}" must be an object`,
      {
        field,
        reason: 'required_object',
        received: actor,
      },
    );
  }

  switch (actor.kind) {
    case 'contact':
      assertNonEmptyString(actor.contactId, `${field}.contactId`);
      return;
    case 'platform_user':
      assertNonEmptyString(actor.userId, `${field}.userId`);
      return;
    case 'api_key':
      assertNonEmptyString(actor.keyId, `${field}.keyId`);
      return;
    case 'service_principal':
      assertNonEmptyString(actor.principalType, `${field}.principalType`);
      if (
        !SERVICE_PRINCIPAL_TYPES.includes(
          actor.principalType as (typeof SERVICE_PRINCIPAL_TYPES)[number],
        )
      ) {
        throw new ScopeValidationError(
          'INVALID_SESSION_SCOPE',
          `Session scope field "${field}.principalType" is not supported`,
          {
            field: `${field}.principalType`,
            reason: 'unsupported_service_principal_type',
            received: actor.principalType,
          },
        );
      }
      assertNonEmptyString(actor.principalId, `${field}.principalId`);
      return;
    default:
      throw new ScopeValidationError(
        'INVALID_SESSION_SCOPE',
        `Session scope field "${field}.kind" is not a supported actor kind`,
        {
          field: `${field}.kind`,
          reason: 'unsupported_actor_kind',
          received: actor.kind,
        },
      );
  }
}

export function assertProductionExecutionScope(
  scope: unknown,
): asserts scope is ProductionExecutionScope {
  if (!isRecord(scope)) {
    throw new ScopeValidationError('INVALID_SESSION_SCOPE', 'Session scope must be an object', {
      field: 'scope',
      reason: 'required_object',
      received: scope,
    });
  }

  if (scope.kind !== 'production') {
    throw new ScopeValidationError(
      'UNSUPPORTED_SCOPE_KIND',
      'Only production execution scope is supported for this path',
      {
        field: 'kind',
        reason: 'unsupported_scope_kind',
        received: scope.kind,
      },
    );
  }

  assertNonEmptyString(scope.tenantId, 'tenantId');
  assertNonEmptyString(scope.projectId, 'projectId');
  assertNonEmptyString(scope.sessionId, 'sessionId');
  assertNonEmptyString(scope.sessionPrincipalId, 'sessionPrincipalId');
  assertNonEmptyString(scope.channelId, 'channelId');
  assertNonEmptyString(scope.environment, 'environment');
  assertNonEmptyString(scope.source, 'source');
  assertNonEmptyString(scope.authType, 'authType');
  assertNonEmptyString(scope.traceId, 'traceId');

  assertSessionActor(scope.actor, 'actor');
  assertSessionSubject(scope.subject, 'subject');
  assertIdentityEvidence(scope.identityEvidence, 'identityEvidence');

  if (!isRecord(scope.callerContext)) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      'Session scope field "callerContext" must be an object',
      {
        field: 'callerContext',
        reason: 'required_object',
        received: scope.callerContext,
      },
    );
  }
}
