import type {
  AuditActorType,
  AuditLog,
  AuditMetadataEncoding,
  AuditResourceType,
  AuditRetentionClass,
  AuditSource,
  Environment,
} from '../core/types.js';

export type SharedAuditSource = AuditSource;
export type SharedAuditMetadataEncoding = AuditMetadataEncoding;
export type SharedAuditRetentionClass = AuditRetentionClass;

export interface SharedAuditRetentionConfig {
  ttlEnabled: boolean;
  authTtlDays: number;
  crudTtlDays: number;
  defaultTtlDays: number;
}

export const SHARED_AUDIT_RETENTION_DEFAULTS = {
  ttlEnabled: false,
  authTtlDays: 90,
  crudTtlDays: 365,
  defaultTtlDays: 180,
} as const;

export type SharedAuditRecordKind =
  | 'canonical-v2'
  | 'legacy-string-metadata'
  | 'legacy-object-metadata'
  | 'mongoose-plugin'
  | 'unknown';

export interface SharedAuditEnvelope {
  schemaVersion: 2;
  source: SharedAuditSource;
  eventType: string;
  action: string;
  actorId: string | null;
  actorType: AuditActorType;
  tenantId: string | null;
  projectId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  environment: Environment | null;
  traceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  metadataEncoding: SharedAuditMetadataEncoding;
  retentionClass: SharedAuditRetentionClass;
  expiresAt?: Date | null;
  timestamp?: Date;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
}

export interface SharedAuditRecord {
  _id?: string;
  userId?: string | null;
  tenantId?: string | null;
  action?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | string | null;
  eventType?: string | null;
  actorType?: string | null;
  projectId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  environment?: string | null;
  traceId?: string | null;
  source?: string | null;
  schemaVersion?: number | null;
  metadataEncoding?: string | null;
  retentionClass?: string | null;
  expiresAt?: Date | string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  collectionName?: string | null;
  documentId?: string | null;
  operation?: string | null;
  changes?: Record<string, unknown> | null;
  previousValues?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface SharedAuditDecodeResult {
  kind: SharedAuditRecordKind;
  envelope: SharedAuditEnvelope | null;
  warnings: string[];
}

export interface SharedAuditMongoDocument {
  _id: string;
  userId: string | null;
  tenantId: string | null;
  action: string;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | string | null;
  eventType: string;
  actorType: AuditActorType;
  projectId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  environment: Environment | null;
  traceId: string | null;
  source: SharedAuditSource;
  schemaVersion: number;
  metadataEncoding: SharedAuditMetadataEncoding;
  retentionClass: SharedAuditRetentionClass;
  expiresAt: Date | null;
}

type SharedAuditBackfillField = Exclude<keyof SharedAuditMongoDocument, '_id' | 'metadata'>;
type SharedAuditBackfillPatch = Partial<Pick<SharedAuditMongoDocument, SharedAuditBackfillField>>;

const KNOWN_SOURCES = new Set<SharedAuditSource>([
  'runtime-store',
  'runtime-auth',
  'studio',
  'admin',
  'search-ai',
  'mongoose-plugin',
]);

const KNOWN_ACTOR_TYPES = new Set<AuditActorType>(['user', 'admin', 'agent', 'system', 'unknown']);
const KNOWN_METADATA_ENCODINGS = new Set<SharedAuditMetadataEncoding>(['object', 'json-string']);
const KNOWN_RETENTION_CLASSES = new Set<SharedAuditRetentionClass>([
  'default',
  'auth',
  'crud',
  'indefinite',
]);
const BARE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const CANONICAL_METADATA_KEYS = new Set([
  'eventType',
  'actorType',
  'tenantId',
  'projectId',
  'resourceType',
  'resourceId',
  'environment',
  'traceId',
  'oldValue',
  'newValue',
  'source',
  'schemaVersion',
  'metadataEncoding',
  'retentionClass',
  'expiresAt',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const normalized = BARE_TIMESTAMP_RE.test(value) ? `${value.replace(' ', 'T')}Z` : value;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function asActorType(value: unknown): AuditActorType {
  return KNOWN_ACTOR_TYPES.has(value as AuditActorType) ? (value as AuditActorType) : 'unknown';
}

function asEnvironment(value: unknown): Environment | null {
  if (value === 'dev' || value === 'staging' || value === 'production') {
    return value;
  }
  return null;
}

function asRetentionClass(value: unknown): SharedAuditRetentionClass | null {
  return KNOWN_RETENTION_CLASSES.has(value as SharedAuditRetentionClass)
    ? (value as SharedAuditRetentionClass)
    : null;
}

function asMetadataEncoding(value: unknown): SharedAuditMetadataEncoding | null {
  return KNOWN_METADATA_ENCODINGS.has(value as SharedAuditMetadataEncoding)
    ? (value as SharedAuditMetadataEncoding)
    : null;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return fallback;
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function getSharedAuditRetentionConfig(
  env: Record<string, string | undefined> = process.env,
): SharedAuditRetentionConfig {
  return {
    ttlEnabled: parseBooleanEnv(
      env.AUDIT_LOG_TTL_ENABLED,
      SHARED_AUDIT_RETENTION_DEFAULTS.ttlEnabled,
    ),
    authTtlDays: parsePositiveIntegerEnv(
      env.AUDIT_LOG_AUTH_TTL_DAYS,
      SHARED_AUDIT_RETENTION_DEFAULTS.authTtlDays,
    ),
    crudTtlDays: parsePositiveIntegerEnv(
      env.AUDIT_LOG_CRUD_TTL_DAYS,
      SHARED_AUDIT_RETENTION_DEFAULTS.crudTtlDays,
    ),
    defaultTtlDays: parsePositiveIntegerEnv(
      env.AUDIT_LOG_DEFAULT_TTL_DAYS,
      SHARED_AUDIT_RETENTION_DEFAULTS.defaultTtlDays,
    ),
  };
}

export function deriveSharedAuditSource(input: {
  explicitSource?: SharedAuditSource | null;
  eventType?: string | null;
  action?: string | null;
}): SharedAuditSource {
  if (input.explicitSource && KNOWN_SOURCES.has(input.explicitSource)) {
    return input.explicitSource;
  }

  const identity = `${input.action ?? ''} ${input.eventType ?? ''}`.toLowerCase();
  if (
    identity.includes('login') ||
    identity.includes('logout') ||
    identity.includes('oauth') ||
    identity.includes('mfa') ||
    identity.includes('sso') ||
    identity.includes('device_auth') ||
    identity.includes('auth')
  ) {
    return 'runtime-auth';
  }
  if (identity.includes('secret_') || identity.includes('config_')) {
    return 'admin';
  }
  return 'runtime-store';
}

export function computeSharedAuditExpiresAt(
  retentionClass: SharedAuditRetentionClass,
  config: SharedAuditRetentionConfig = getSharedAuditRetentionConfig(),
  now = new Date(),
): Date | null {
  if (!config.ttlEnabled || retentionClass === 'indefinite') {
    return null;
  }

  const ttlDays =
    retentionClass === 'auth'
      ? config.authTtlDays
      : retentionClass === 'crud'
        ? config.crudTtlDays
        : config.defaultTtlDays;

  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

function asSource(value: unknown): SharedAuditSource | null {
  return KNOWN_SOURCES.has(value as SharedAuditSource) ? (value as SharedAuditSource) : null;
}

function hasBackfillableValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  return !(typeof value === 'string' && value.length === 0);
}

function sanitizeCustomMetadata(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }

  const customMetadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!CANONICAL_METADATA_KEYS.has(key)) {
      customMetadata[key] = value;
    }
  }
  return Object.keys(customMetadata).length > 0 ? customMetadata : null;
}

function parseMetadata(rawMetadata: SharedAuditRecord['metadata']): {
  metadata: Record<string, unknown> | null;
  encoding: SharedAuditMetadataEncoding;
  warnings: string[];
} {
  if (typeof rawMetadata === 'string') {
    try {
      const parsed = JSON.parse(rawMetadata) as unknown;
      if (isRecord(parsed)) {
        return { metadata: parsed, encoding: 'json-string', warnings: [] };
      }
      return {
        metadata: null,
        encoding: 'json-string',
        warnings: ['Metadata string did not decode to an object'],
      };
    } catch (error) {
      return {
        metadata: null,
        encoding: 'json-string',
        warnings: [
          `Metadata string could not be parsed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
  }

  if (isRecord(rawMetadata)) {
    return { metadata: rawMetadata, encoding: 'object', warnings: [] };
  }

  return { metadata: null, encoding: 'object', warnings: [] };
}

function inferSource(
  record: SharedAuditRecord,
  kind: SharedAuditRecordKind,
  metadata: Record<string, unknown> | null,
): SharedAuditSource {
  const explicit = asSource(record.source) ?? asSource(metadata?.source);
  if (explicit) {
    return explicit;
  }
  if (kind === 'mongoose-plugin') {
    return 'mongoose-plugin';
  }

  return deriveSharedAuditSource({
    eventType: asString(record.eventType) ?? asString(metadata?.eventType),
    action: asString(record.action),
  });
}

export function deriveRetentionClass(input: {
  source?: SharedAuditSource | null;
  eventType?: string | null;
  action?: string | null;
  explicitRetentionClass?: SharedAuditRetentionClass | null;
}): SharedAuditRetentionClass {
  if (input.explicitRetentionClass) {
    return input.explicitRetentionClass;
  }

  const source = input.source ?? null;
  const identity = `${input.eventType ?? ''} ${input.action ?? ''}`.toLowerCase();
  if (source === 'runtime-auth') {
    return 'auth';
  }
  if (
    identity.includes('login') ||
    identity.includes('logout') ||
    identity.includes('oauth') ||
    identity.includes('mfa') ||
    identity.includes('sso') ||
    identity.includes('token')
  ) {
    return 'auth';
  }
  if (
    identity.includes('create') ||
    identity.includes('created') ||
    identity.includes('update') ||
    identity.includes('updated') ||
    identity.includes('delete') ||
    identity.includes('deleted') ||
    identity.includes('archive') ||
    identity.includes('promote') ||
    identity.includes('rollback') ||
    identity.includes('rotate') ||
    identity.includes('revoke')
  ) {
    return 'crud';
  }
  return 'default';
}

export function classifySharedAuditRecord(record: SharedAuditRecord): SharedAuditRecordKind {
  if (
    asString(record.collectionName) ||
    asString(record.documentId) ||
    asString(record.operation)
  ) {
    return 'mongoose-plugin';
  }
  if (
    record.schemaVersion === 2 ||
    asString(record.eventType) ||
    asString(record.source) ||
    asString(record.metadataEncoding)
  ) {
    return 'canonical-v2';
  }
  if (typeof record.metadata === 'string') {
    return 'legacy-string-metadata';
  }
  if (isRecord(record.metadata)) {
    return 'legacy-object-metadata';
  }
  return 'unknown';
}

export function decodeSharedAuditRecord(record: SharedAuditRecord): SharedAuditDecodeResult {
  const kind = classifySharedAuditRecord(record);

  if (kind === 'unknown') {
    return {
      kind,
      envelope: null,
      warnings: ['Record shape is not recognized as canonical, legacy, or plugin audit data'],
    };
  }

  if (kind === 'mongoose-plugin') {
    const source: SharedAuditSource = 'mongoose-plugin';
    const explicitRetentionClass = asRetentionClass(record.retentionClass);
    return {
      kind,
      envelope: {
        schemaVersion: 2,
        source,
        eventType: `mongoose.${asString(record.operation) ?? 'unknown'}`,
        action: asString(record.operation) ?? 'unknown',
        actorId: asString(record.userId) ?? null,
        actorType: 'unknown',
        tenantId: asString(record.tenantId) ?? null,
        projectId: null,
        resourceType: asString(record.collectionName) ?? null,
        resourceId: asString(record.documentId) ?? null,
        environment: null,
        traceId: null,
        ipAddress: asString(record.ip) ?? null,
        userAgent: asString(record.userAgent) ?? null,
        metadata: sanitizeCustomMetadata({
          ...(isRecord(record.changes) ? { changes: record.changes } : {}),
          ...(isRecord(record.previousValues) ? { previousValues: record.previousValues } : {}),
        }),
        metadataEncoding: 'object',
        retentionClass: deriveRetentionClass({
          source,
          eventType: asString(record.operation),
          action: asString(record.operation),
          explicitRetentionClass,
        }),
        expiresAt: asDate(record.expiresAt),
        timestamp: asDate(record.createdAt) ?? undefined,
        oldValue: isRecord(record.previousValues) ? record.previousValues : null,
        newValue: isRecord(record.changes) ? record.changes : null,
      },
      warnings: [],
    };
  }

  const parsedMetadata = parseMetadata(record.metadata);
  const metadata = parsedMetadata.metadata;
  const source = inferSource(record, kind, metadata);
  const explicitRetentionClass =
    asRetentionClass(record.retentionClass) ?? asRetentionClass(metadata?.retentionClass);
  const metadataEncoding =
    asMetadataEncoding(record.metadataEncoding) ??
    asMetadataEncoding(metadata?.metadataEncoding) ??
    parsedMetadata.encoding;
  const envelope: SharedAuditEnvelope = {
    schemaVersion: 2,
    source,
    eventType:
      asString(record.eventType) ??
      asString(metadata?.eventType) ??
      asString(record.action) ??
      'unknown',
    action: asString(record.action) ?? asString(metadata?.eventType) ?? 'unknown',
    actorId: asString(record.userId) ?? asString(metadata?.actor) ?? null,
    actorType: asActorType(record.actorType ?? metadata?.actorType),
    tenantId: asString(record.tenantId) ?? asString(metadata?.tenantId) ?? null,
    projectId: asString(record.projectId) ?? asString(metadata?.projectId) ?? null,
    resourceType: asString(record.resourceType) ?? asString(metadata?.resourceType) ?? null,
    resourceId: asString(record.resourceId) ?? asString(metadata?.resourceId) ?? null,
    environment: asEnvironment(record.environment ?? metadata?.environment),
    traceId: asString(record.traceId) ?? asString(metadata?.traceId) ?? null,
    ipAddress: asString(record.ip) ?? null,
    userAgent: asString(record.userAgent) ?? null,
    metadata: sanitizeCustomMetadata(metadata),
    metadataEncoding,
    retentionClass: deriveRetentionClass({
      source,
      eventType: asString(record.eventType) ?? asString(metadata?.eventType),
      action: asString(record.action),
      explicitRetentionClass,
    }),
    expiresAt: asDate(record.expiresAt) ?? asDate(metadata?.expiresAt),
    timestamp: asDate(record.createdAt) ?? undefined,
    oldValue: isRecord(metadata?.oldValue) ? metadata.oldValue : null,
    newValue: isRecord(metadata?.newValue) ? metadata.newValue : null,
  };

  return {
    kind,
    envelope,
    warnings: parsedMetadata.warnings,
  };
}

export function createSharedAuditEnvelopeFromAuditLog(
  auditLog: AuditLog,
  options?: {
    source?: SharedAuditSource;
    metadataEncoding?: SharedAuditMetadataEncoding;
    retentionClass?: SharedAuditRetentionClass;
    expiresAt?: Date | null;
  },
): SharedAuditEnvelope {
  const source = options?.source ?? auditLog.source ?? 'runtime-store';
  const metadataEncoding = options?.metadataEncoding ?? auditLog.metadataEncoding ?? 'object';
  const retentionClass =
    options?.retentionClass ??
    auditLog.retentionClass ??
    deriveRetentionClass({
      source,
      eventType: auditLog.eventType,
      action: auditLog.action,
      explicitRetentionClass: null,
    });

  return {
    schemaVersion: 2,
    source,
    eventType: auditLog.eventType,
    action: auditLog.action,
    actorId: auditLog.actor,
    actorType: auditLog.actorType,
    tenantId: auditLog.tenantId,
    projectId: auditLog.projectId ?? null,
    resourceType: auditLog.resourceType,
    resourceId: auditLog.resourceId,
    environment: auditLog.environment,
    traceId: auditLog.traceId ?? null,
    ipAddress: auditLog.ipAddress ?? null,
    userAgent: null,
    metadata: auditLog.metadata,
    metadataEncoding,
    retentionClass,
    expiresAt: options?.expiresAt ?? auditLog.expiresAt ?? null,
    timestamp: auditLog.timestamp,
    oldValue: auditLog.oldValue ?? null,
    newValue: auditLog.newValue ?? null,
  };
}

function buildCompatibilityMetadata(envelope: SharedAuditEnvelope): Record<string, unknown> {
  const expiresAt =
    envelope.expiresAt ?? computeSharedAuditExpiresAt(envelope.retentionClass, undefined);
  const customMetadata = sanitizeCustomMetadata(envelope.metadata) ?? {};

  return {
    ...customMetadata,
    eventType: envelope.eventType,
    actorType: envelope.actorType,
    tenantId: envelope.tenantId,
    projectId: envelope.projectId,
    resourceType: envelope.resourceType,
    resourceId: envelope.resourceId,
    environment: envelope.environment,
    traceId: envelope.traceId,
    oldValue: envelope.oldValue,
    newValue: envelope.newValue,
    source: envelope.source,
    schemaVersion: envelope.schemaVersion,
    metadataEncoding: envelope.metadataEncoding,
    retentionClass: envelope.retentionClass,
    expiresAt,
  };
}

export function encodeSharedAuditEnvelopeToMongoDocument(
  id: string,
  envelope: SharedAuditEnvelope,
): SharedAuditMongoDocument {
  const expiresAt =
    envelope.expiresAt ?? computeSharedAuditExpiresAt(envelope.retentionClass, undefined);
  const compatibilityMetadata = buildCompatibilityMetadata(envelope);
  return {
    _id: id,
    userId: envelope.actorId,
    tenantId: envelope.tenantId,
    action: envelope.action,
    ip: envelope.ipAddress,
    userAgent: envelope.userAgent,
    metadata:
      envelope.metadataEncoding === 'json-string'
        ? JSON.stringify(compatibilityMetadata)
        : compatibilityMetadata,
    eventType: envelope.eventType,
    actorType: envelope.actorType,
    projectId: envelope.projectId,
    resourceType: envelope.resourceType,
    resourceId: envelope.resourceId,
    environment: envelope.environment,
    traceId: envelope.traceId,
    source: envelope.source,
    schemaVersion: envelope.schemaVersion,
    metadataEncoding: envelope.metadataEncoding,
    retentionClass: envelope.retentionClass,
    expiresAt,
  };
}

export function toAuditLog(envelope: SharedAuditEnvelope, id: string): AuditLog {
  const metadata: Record<string, unknown> = envelope.metadata ?? {};
  return {
    id,
    tenantId: envelope.tenantId ?? 'unscoped',
    projectId: envelope.projectId ?? undefined,
    timestamp: envelope.timestamp ?? new Date(),
    eventType: envelope.eventType as AuditLog['eventType'],
    actor: envelope.actorId ?? 'system',
    actorType: envelope.actorType,
    resourceType: (envelope.resourceType ?? 'agent') as AuditResourceType,
    resourceId: envelope.resourceId ?? '',
    environment: envelope.environment ?? 'dev',
    action: envelope.action,
    oldValue: envelope.oldValue ?? undefined,
    newValue: envelope.newValue ?? undefined,
    metadata,
    ipAddress: envelope.ipAddress ?? undefined,
    traceId: envelope.traceId ?? undefined,
    schemaVersion: envelope.schemaVersion,
    source: envelope.source,
    metadataEncoding: envelope.metadataEncoding,
    retentionClass: envelope.retentionClass,
    expiresAt: envelope.expiresAt ?? null,
  };
}

export function getMissingCanonicalFields(
  record: SharedAuditRecord,
  envelope: SharedAuditEnvelope,
): string[] {
  const missingFields: string[] = [];
  const canonicalFields: Array<keyof SharedAuditMongoDocument> = [
    'eventType',
    'actorType',
    'projectId',
    'resourceType',
    'resourceId',
    'environment',
    'traceId',
    'source',
    'schemaVersion',
    'metadataEncoding',
    'retentionClass',
  ];

  for (const field of canonicalFields) {
    const currentValue = record[field];
    const expectedValue = encodeSharedAuditEnvelopeToMongoDocument(
      asString(record._id) ?? 'compat-check',
      envelope,
    )[field];
    if (!hasBackfillableValue(expectedValue)) {
      continue;
    }

    if (
      currentValue === undefined ||
      currentValue === null ||
      (typeof currentValue === 'string' && currentValue.length === 0 && expectedValue !== null)
    ) {
      missingFields.push(field);
    }
  }

  return missingFields;
}

export function buildSharedAuditBackfillPatch(record: SharedAuditRecord): {
  kind: SharedAuditRecordKind;
  patch: SharedAuditBackfillPatch;
  warnings: string[];
} {
  const decoded = decodeSharedAuditRecord(record);
  if (!decoded.envelope || decoded.kind === 'mongoose-plugin' || decoded.kind === 'unknown') {
    return { kind: decoded.kind, patch: {}, warnings: decoded.warnings };
  }

  const canonicalDocument = encodeSharedAuditEnvelopeToMongoDocument(
    asString(record._id) ?? 'compat-backfill',
    decoded.envelope,
  );
  const patchEntries: Array<
    [SharedAuditBackfillField, SharedAuditMongoDocument[SharedAuditBackfillField]]
  > = [];

  for (const [field, value] of Object.entries(canonicalDocument) as Array<
    [keyof SharedAuditMongoDocument, SharedAuditMongoDocument[keyof SharedAuditMongoDocument]]
  >) {
    if (field === '_id' || field === 'metadata') {
      continue;
    }
    if (!hasBackfillableValue(value)) {
      continue;
    }
    const backfillField = field as SharedAuditBackfillField;
    const currentValue = record[field];
    if (
      currentValue === undefined ||
      currentValue === null ||
      (typeof currentValue === 'string' && currentValue.length === 0)
    ) {
      patchEntries.push([backfillField, value as SharedAuditMongoDocument[typeof backfillField]]);
    }
  }

  const patch = Object.fromEntries(patchEntries) as SharedAuditBackfillPatch;
  return { kind: decoded.kind, patch, warnings: decoded.warnings };
}
