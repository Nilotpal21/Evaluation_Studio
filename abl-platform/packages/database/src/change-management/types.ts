export const CHANGE_ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
export type ChangeEnvironment = (typeof CHANGE_ENVIRONMENTS)[number];

export const CHANGE_PHASES = ['pre_deploy', 'inline', 'post_deploy', 'continuous'] as const;
export type ChangePhase = (typeof CHANGE_PHASES)[number];

export const CHANGE_TRIGGERS = ['deploy', 'manual', 'tenant_lifecycle'] as const;
export type ChangeTrigger = (typeof CHANGE_TRIGGERS)[number];

export const CHANGE_KINDS = [
  'schema',
  'backfill',
  'seed_platform',
  'seed_tenant',
  'seed_dev',
  'secret',
  'bridge',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const CHANGE_ENGINES = [
  'mongodb',
  'clickhouse',
  'script',
  'eventstore',
  'secrets_manager',
] as const;
export type ChangeEngine = (typeof CHANGE_ENGINES)[number];

export const CHANGE_SCOPES = ['global', 'tenant'] as const;
export type ChangeScope = (typeof CHANGE_SCOPES)[number];

export const CHANGE_BLOCKING_MODES = [
  'deploy_required',
  'startup_required',
  'async_required',
  'bootstrap_only',
  'warn_only',
  'manual_only',
] as const;
export type ChangeBlocking = (typeof CHANGE_BLOCKING_MODES)[number];

export const CHANGE_REVERSIBILITY_MODES = [
  'down',
  'compensating',
  'forward_only',
  'not_applicable',
] as const;
export type ChangeReversibility = (typeof CHANGE_REVERSIBILITY_MODES)[number];

export const CHANGE_LIFECYCLES = ['active', 'inventory_only', 'deprecated'] as const;
export type ChangeLifecycle = (typeof CHANGE_LIFECYCLES)[number];

export const CHANGE_ENFORCEMENT_MODES = [
  'soft_ready',
  'hard_fail',
  'warn_only',
  'proxy_only',
] as const;
export type ChangeEnforcementMode = (typeof CHANGE_ENFORCEMENT_MODES)[number];

export const CHANGE_HISTORY_STATUSES = [
  'pending',
  'applied',
  'verified',
  'failed',
  'rolled_back',
  'skipped',
] as const;
export type ChangeHistoryStatus = (typeof CHANGE_HISTORY_STATUSES)[number];

export const CHANGE_VALIDATION_STATUSES = [
  'passed',
  'failed',
  'not_configured',
  'never_run',
] as const;
export type ChangeValidationStatus = (typeof CHANGE_VALIDATION_STATUSES)[number];

export const CHANGE_RELEASE_EVIDENCE_FIELDS = [
  'configSnapshotRef',
  'configDiffRef',
  'lowerEnvironmentValidationRef',
  'observabilityRef',
  'traceId',
] as const;
export type ChangeReleaseEvidenceField = (typeof CHANGE_RELEASE_EVIDENCE_FIELDS)[number];

export const CHANGE_OBSERVABILITY_DIMENSIONS = [
  'environment',
  'releaseId',
  'changeId',
  'service',
] as const;
export type ChangeObservabilityDimension = (typeof CHANGE_OBSERVABILITY_DIMENSIONS)[number];

export interface ChangeReleaseEvidenceRefs {
  configSnapshotRef?: string | null;
  configDiffRef?: string | null;
  lowerEnvironmentValidationRef?: string | null;
  observabilityRef?: string | null;
  traceId?: string | null;
}

export interface LegacyLedgerMapping {
  sourceCollection: string;
  identifierField: string;
  statusField: string;
  checksumField?: string;
  validationStatusField?: string;
  targetField?: string;
  notes?: string;
}

export interface ChangeManifestEntry {
  id: string;
  legacyId?: string;
  description: string;
  sourcePaths: string[];
  engine: ChangeEngine;
  kind: ChangeKind;
  phase: ChangePhase;
  trigger: ChangeTrigger;
  blocking: ChangeBlocking;
  scope: ChangeScope;
  environments: ChangeEnvironment[];
  lifecycle: ChangeLifecycle;
  reversibility: ChangeReversibility;
  destructive: boolean;
  requires: string[];
  legacyLedger?: LegacyLedgerMapping | null;
  evidenceFields: ChangeReleaseEvidenceField[];
  observabilityDimensions: ChangeObservabilityDimension[];
  requiredByServices?: string[];
  notes?: string;
}

export const KNOWN_CHANGE_SURFACE_DISPOSITIONS = [
  'registered',
  'non_release_coupled',
  'deprecated',
] as const;
export type KnownChangeSurfaceDisposition = (typeof KNOWN_CHANGE_SURFACE_DISPOSITIONS)[number];

export interface KnownChangeSurface {
  surfaceKey: string;
  path: string;
  disposition: KnownChangeSurfaceDisposition;
  expectedManifestId?: string;
  notes?: string;
}

export const MANIFEST_VALIDATION_ISSUE_CODES = [
  'duplicate_change_id',
  'missing_dependency',
  'cyclic_dependency',
  'illegal_combination',
  'missing_registered_surface',
  'invalid_entry',
] as const;
export type ManifestValidationIssueCode = (typeof MANIFEST_VALIDATION_ISSUE_CODES)[number];

export interface ManifestValidationIssue {
  code: ManifestValidationIssueCode;
  severity: 'error' | 'warning';
  message: string;
  changeId?: string;
  dependencyId?: string;
  path?: string;
  relatedChangeIds?: string[];
  surfaceKey?: string;
}

export interface ManifestValidationResult {
  ok: boolean;
  issues: ManifestValidationIssue[];
}

export interface ChangeHistoryEntry {
  changeId: string;
  legacyId?: string;
  description: string;
  environment?: ChangeEnvironment;
  engine: ChangeEngine;
  kind: ChangeKind;
  phase: ChangePhase;
  scope: ChangeScope;
  status: ChangeHistoryStatus;
  validationStatus?: ChangeValidationStatus;
  validationSummary?: string;
  validationDetails?: Record<string, unknown>;
  checksum?: string;
  targetKey?: string | null;
  runCount?: number;
  releaseId?: string | null;
  durationMs?: number;
  lastError?: string | null;
  appliedBy?: string | null;
  buildInfo?: Record<string, unknown>;
  fence?: number | null;
  appliedAt?: Date;
  lastValidatedAt?: Date;
  fenceToken?: number | null;
  releaseEvidence?: ChangeReleaseEvidenceRefs;
}

export interface ServiceChangeRequirement {
  service: string;
  environment: ChangeEnvironment;
  enforcementMode: ChangeEnforcementMode;
  requiredChangeIds: string[];
  optionalChangeIds?: string[];
  notes?: string;
}
