import { createLogger } from '@abl/compiler/platform';
import type { PIIToken, PIIVault, PIIPatternConfig } from '@abl/compiler/platform';
import type { PIITokenSourceSurface } from '@agent-platform/database/models';
import { emitPIIAuditEvent } from '../execution/pii-audit-store-adapter.js';

const log = createLogger('pii-token-vault-service');

const DEFAULT_DURABLE_PII_TOKEN_VAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_PII_REVEAL_SELECTOR_COUNT = 50;

export interface PIITokenVaultSource {
  sourceSurface?: PIITokenSourceSurface;
  sourceMessageId?: string;
  sourceTraceId?: string;
  sourceSpanId?: string;
  sourceFieldPath?: string;
}

export interface PIITokenVaultInsert {
  tenantId: string;
  projectId: string;
  sessionId: string;
  tokenId: string;
  token: string;
  piiType: string;
  patternName: string;
  encryptedOriginalValue: string;
  /** Detection confidence carried over from the source PIIDetection (0..1). */
  confidence?: number;
  /** Originating recognizer name (e.g. 'core-email', 'eu-iban'). */
  recognizer?: string;
  sourceSurface: PIITokenSourceSurface;
  sourceMessageId?: string;
  sourceTraceId?: string;
  sourceSpanId?: string;
  sourceFieldPath?: string;
  revealable: boolean;
  expireAt: Date;
}

export interface PIITokenVaultRepository {
  insertMany(docs: PIITokenVaultInsert[], options: { ordered: false }): Promise<unknown>;
}

export interface PIITokenRevealSourceRef {
  sourceMessageId?: string;
  sourceTraceId?: string;
  sourceSpanId?: string;
  sourceFieldPath?: string;
}

export interface PIITokenRevealActor {
  actorId: string;
  authType: string;
  role?: string;
  apiKeyId?: string;
  clientId?: string;
}

export interface PIITokenVaultRevealRecord {
  tenantId: string;
  projectId: string;
  sessionId: string;
  tokenId: string;
  token: string;
  piiType: string;
  patternName: string;
  encryptedOriginalValue: string | null;
  sourceSurface: PIITokenSourceSurface;
  sourceMessageId?: string;
  sourceTraceId?: string;
  sourceSpanId?: string;
  sourceFieldPath?: string;
  revealable: boolean;
  erasedAt?: Date | null;
  expireAt: Date;
}

export interface PIITokenRevealRepository {
  find(
    filter: Record<string, unknown>,
  ): PromiseLike<PIITokenVaultRevealRecord[]> | { exec(): Promise<PIITokenVaultRevealRecord[]> };
}

export interface PIIRevealAuditLogInsert {
  tenantId: string;
  projectId: string;
  sessionId: string;
  tokenId: string;
  piiType: string;
  consumer: 'admin';
  renderMode: 'original';
  action: 'detokenize';
  metadata: Record<string, unknown>;
}

export interface PIIRevealAuditLogRepository {
  insertMany(docs: PIIRevealAuditLogInsert[], options: { ordered: true }): Promise<unknown>;
}

export interface PIIRevealRepositories {
  tokenVault: PIITokenRevealRepository;
  auditLog?: PIIRevealAuditLogRepository;
}

export type PIITokenRevealUnavailableReason = 'not_found' | 'not_revealable' | 'erased' | 'expired';

export interface RevealedPIIToken {
  tokenId: string;
  token: string;
  piiType: string;
  patternName: string;
  value: string;
  source: {
    surface: PIITokenSourceSurface;
    messageId?: string;
    traceId?: string;
    spanId?: string;
    fieldPath?: string;
  };
}

export interface UnavailablePIIToken {
  tokenId: string;
  status: PIITokenRevealUnavailableReason;
  piiType?: string;
  patternName?: string;
}

export interface RevealPIITokensParams {
  tenantId: string;
  projectId: string;
  sessionId: string;
  tokenIds?: string[];
  sourceRefs?: PIITokenRevealSourceRef[];
  reason: string;
  ticketId?: string;
  actor: PIITokenRevealActor;
  repositories?: PIIRevealRepositories;
  now?: () => Date;
}

export interface RevealPIITokensResult {
  revealed: RevealedPIIToken[];
  unavailable: UnavailablePIIToken[];
  auditLogCount: number;
}

export class PIIRevealAuditError extends Error {
  constructor() {
    super('PII reveal audit write failed');
    this.name = 'PIIRevealAuditError';
  }
}

export interface FlushPIIVaultToDurableStoreParams {
  tenantId?: string;
  projectId?: string;
  sessionId?: string;
  vault?: PIIVault;
  patternConfigs?: PIIPatternConfig[];
  source?: PIITokenVaultSource;
  revealable?: boolean;
  expiresAt?: Date;
  now?: () => number;
  repository?: PIITokenVaultRepository;
}

export interface FlushPIIVaultToDurableStoreResult {
  flushed: number;
  skipped: boolean;
  reason?: 'missingVault' | 'emptyVault' | 'missingScope' | 'notRevealable' | 'insertFailed';
  duplicateCount?: number;
}

export interface SessionPIIVaultFlushTarget {
  id: string;
  tenantId?: string;
  projectId?: string;
  piiVault?: PIIVault;
  piiPatternConfigs?: PIIPatternConfig[];
  piiRedactionConfig?: { enabled?: boolean };
}

interface ScopedPIITokenVaultParams {
  tenantId: string;
  projectId: string;
  sessionId: string;
}

function hasScopeValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function getPatternName(token: PIIToken, patternConfigs?: PIIPatternConfig[]): string {
  const config = patternConfigs?.find((candidate) => candidate.patternName === token.type);
  return config?.patternName ?? token.type;
}

function buildVaultInsert(
  token: PIIToken,
  params: ScopedPIITokenVaultParams,
  options: {
    patternConfigs?: PIIPatternConfig[];
    source?: PIITokenVaultSource;
    revealable: boolean;
    expireAt: Date;
  },
): PIITokenVaultInsert {
  return {
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
    tokenId: token.id,
    token: token.token,
    piiType: token.type,
    patternName: getPatternName(token, options.patternConfigs),
    encryptedOriginalValue: token.original,
    ...(token.confidence !== undefined ? { confidence: token.confidence } : {}),
    ...(token.recognizer ? { recognizer: token.recognizer } : {}),
    sourceSurface: options.source?.sourceSurface ?? 'unknown',
    ...(options.source?.sourceMessageId ? { sourceMessageId: options.source.sourceMessageId } : {}),
    ...(options.source?.sourceTraceId ? { sourceTraceId: options.source.sourceTraceId } : {}),
    ...(options.source?.sourceSpanId ? { sourceSpanId: options.source.sourceSpanId } : {}),
    ...(options.source?.sourceFieldPath ? { sourceFieldPath: options.source.sourceFieldPath } : {}),
    revealable: options.revealable,
    expireAt: options.expireAt,
  };
}

function countDuplicateKeyErrors(err: unknown): number {
  const maybeBulkError = err as {
    code?: number;
    writeErrors?: Array<{ code?: number }>;
  };

  const writeErrors = maybeBulkError.writeErrors;
  if (!Array.isArray(writeErrors)) {
    return maybeBulkError.code === 11000 ? 1 : 0;
  }

  return writeErrors.filter((writeError) => writeError.code === 11000).length;
}

function hasNonDuplicateWriteErrors(err: unknown): boolean {
  const writeErrors = (err as { writeErrors?: Array<{ code?: number }> }).writeErrors;
  return Array.isArray(writeErrors) && writeErrors.some((writeError) => writeError.code !== 11000);
}

async function loadDefaultRepository(): Promise<PIITokenVaultRepository> {
  const { PIITokenVault } = await import('@agent-platform/database/models');
  return PIITokenVault as PIITokenVaultRepository;
}

async function loadDefaultRevealRepositories(): Promise<PIIRevealRepositories> {
  const { PIITokenVault } = await import('@agent-platform/database/models');
  return {
    tokenVault: PIITokenVault as PIITokenRevealRepository,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveRevealActorId(metadata: Record<string, unknown>): string | null {
  const actor = metadata.actor;
  if (!isRecord(actor)) {
    return null;
  }

  return typeof actor.actorId === 'string' && actor.actorId.trim().length > 0
    ? actor.actorId
    : null;
}

async function emitRevealAuditEvents(
  docs: PIIRevealAuditLogInsert[],
  timestamp: Date,
): Promise<void> {
  const expiresAt = new Date(timestamp.getTime() + DEFAULT_DURABLE_PII_TOKEN_VAULT_RETENTION_MS);

  await Promise.all(
    docs.map((doc) =>
      emitPIIAuditEvent({
        tenantId: doc.tenantId,
        projectId: doc.projectId,
        sessionId: doc.sessionId,
        tokenId: doc.tokenId,
        piiType: doc.piiType,
        consumer: doc.consumer,
        action: doc.action,
        renderMode: doc.renderMode,
        metadata: doc.metadata,
        actorId: resolveRevealActorId(doc.metadata),
        actorType: 'admin',
        expiresAt,
        timestamp,
      }),
    ),
  );
}

async function executeRevealFind(
  repository: PIITokenRevealRepository,
  filter: Record<string, unknown>,
): Promise<PIITokenVaultRevealRecord[]> {
  const query = repository.find(filter);
  if (typeof (query as { exec?: unknown }).exec === 'function') {
    return (query as { exec(): Promise<PIITokenVaultRevealRecord[]> }).exec();
  }
  return query as PromiseLike<PIITokenVaultRevealRecord[]>;
}

function normalizeSelectorValues(values?: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function normalizeSourceRefs(sourceRefs?: PIITokenRevealSourceRef[]): PIITokenRevealSourceRef[] {
  const result: PIITokenRevealSourceRef[] = [];
  const seen = new Set<string>();

  for (const sourceRef of sourceRefs ?? []) {
    const normalized: PIITokenRevealSourceRef = {
      ...(sourceRef.sourceMessageId?.trim()
        ? { sourceMessageId: sourceRef.sourceMessageId.trim() }
        : {}),
      ...(sourceRef.sourceTraceId?.trim() ? { sourceTraceId: sourceRef.sourceTraceId.trim() } : {}),
      ...(sourceRef.sourceSpanId?.trim() ? { sourceSpanId: sourceRef.sourceSpanId.trim() } : {}),
      ...(sourceRef.sourceFieldPath?.trim()
        ? { sourceFieldPath: sourceRef.sourceFieldPath.trim() }
        : {}),
    };

    if (Object.keys(normalized).length === 0) {
      continue;
    }

    const key = JSON.stringify(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function buildSourceRefFilter(sourceRef: PIITokenRevealSourceRef): Record<string, string> {
  return {
    ...(sourceRef.sourceMessageId ? { sourceMessageId: sourceRef.sourceMessageId } : {}),
    ...(sourceRef.sourceTraceId ? { sourceTraceId: sourceRef.sourceTraceId } : {}),
    ...(sourceRef.sourceSpanId ? { sourceSpanId: sourceRef.sourceSpanId } : {}),
    ...(sourceRef.sourceFieldPath ? { sourceFieldPath: sourceRef.sourceFieldPath } : {}),
  };
}

function buildRevealQueryFilter(params: {
  tenantId: string;
  projectId: string;
  sessionId: string;
  tokenIds: string[];
  sourceRefs: PIITokenRevealSourceRef[];
}): Record<string, unknown> | null {
  const selectors: Record<string, unknown>[] = [];

  if (params.tokenIds.length > 0) {
    selectors.push({ tokenId: { $in: params.tokenIds } });
  }

  for (const sourceRef of params.sourceRefs) {
    selectors.push(buildSourceRefFilter(sourceRef));
  }

  if (selectors.length === 0) {
    return null;
  }

  const scopedFilter = {
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
  };

  if (selectors.length === 1) {
    return { ...scopedFilter, ...selectors[0] };
  }

  return { ...scopedFilter, $or: selectors };
}

function toRevealedToken(record: PIITokenVaultRevealRecord): RevealedPIIToken {
  return {
    tokenId: record.tokenId,
    token: record.token,
    piiType: record.piiType,
    patternName: record.patternName,
    value: record.encryptedOriginalValue ?? '',
    source: {
      surface: record.sourceSurface,
      ...(record.sourceMessageId ? { messageId: record.sourceMessageId } : {}),
      ...(record.sourceTraceId ? { traceId: record.sourceTraceId } : {}),
      ...(record.sourceSpanId ? { spanId: record.sourceSpanId } : {}),
      ...(record.sourceFieldPath ? { fieldPath: record.sourceFieldPath } : {}),
    },
  };
}

function classifyUnavailableRecord(
  record: PIITokenVaultRevealRecord,
  now: Date,
): PIITokenRevealUnavailableReason | null {
  if (record.erasedAt) {
    return 'erased';
  }

  if (!record.revealable || record.encryptedOriginalValue === null) {
    return 'not_revealable';
  }

  if (record.expireAt.getTime() <= now.getTime()) {
    return 'expired';
  }

  return null;
}

function buildRevealAuditDocs(params: {
  tenantId: string;
  projectId: string;
  sessionId: string;
  reason: string;
  ticketId?: string;
  actor: PIITokenRevealActor;
  revealed: RevealedPIIToken[];
}): PIIRevealAuditLogInsert[] {
  return params.revealed.map((token) => ({
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
    tokenId: token.tokenId,
    piiType: token.piiType,
    consumer: 'admin',
    renderMode: 'original',
    action: 'detokenize',
    metadata: {
      reason: params.reason,
      ...(params.ticketId ? { ticketId: params.ticketId } : {}),
      actor: params.actor,
      tokenId: token.tokenId,
      source: token.source,
    },
  }));
}

export async function revealPIITokens(
  params: RevealPIITokensParams,
): Promise<RevealPIITokensResult> {
  const now = params.now?.() ?? new Date();
  const tokenIds = normalizeSelectorValues(params.tokenIds);
  const sourceRefs = normalizeSourceRefs(params.sourceRefs);
  const filter = buildRevealQueryFilter({
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
    tokenIds,
    sourceRefs,
  });

  if (!filter) {
    return { revealed: [], unavailable: [], auditLogCount: 0 };
  }

  const repositories = params.repositories ?? (await loadDefaultRevealRepositories());
  // Do not use `.lean()` here: encryptedOriginalValue relies on the model
  // encryption plugin's post-find decryption path before raw reveal is possible.
  const records = await executeRevealFind(repositories.tokenVault, filter);
  const recordByTokenId = new Map(records.map((record) => [record.tokenId, record]));
  const unavailable: UnavailablePIIToken[] = [];
  const revealed: RevealedPIIToken[] = [];

  for (const tokenId of tokenIds) {
    if (!recordByTokenId.has(tokenId)) {
      unavailable.push({ tokenId, status: 'not_found' });
    }
  }

  for (const record of records) {
    const unavailableReason = classifyUnavailableRecord(record, now);
    if (unavailableReason) {
      unavailable.push({
        tokenId: record.tokenId,
        status: unavailableReason,
        piiType: record.piiType,
        patternName: record.patternName,
      });
      continue;
    }

    revealed.push(toRevealedToken(record));
  }

  if (revealed.length === 0) {
    return { revealed, unavailable, auditLogCount: 0 };
  }

  const auditDocs = buildRevealAuditDocs({
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
    reason: params.reason,
    ticketId: params.ticketId,
    actor: params.actor,
    revealed,
  });

  try {
    if (repositories.auditLog) {
      await repositories.auditLog.insertMany(auditDocs, { ordered: true });
    } else {
      await emitRevealAuditEvents(auditDocs, now);
    }
  } catch (err) {
    log.error('pii-reveal-audit-write-failed', {
      tenantId: params.tenantId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      tokenCount: revealed.length,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PIIRevealAuditError();
  }

  log.info('pii-tokens-revealed', {
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
    tokenCount: revealed.length,
    actorId: params.actor.actorId,
  });

  return { revealed, unavailable, auditLogCount: auditDocs.length };
}

export async function flushPIIVaultToDurableStore(
  params: FlushPIIVaultToDurableStoreParams,
): Promise<FlushPIIVaultToDurableStoreResult> {
  if (!params.vault) {
    return { flushed: 0, skipped: true, reason: 'missingVault' };
  }

  if (params.vault.isEmpty()) {
    return { flushed: 0, skipped: true, reason: 'emptyVault' };
  }

  const tenantId = params.tenantId;
  const projectId = params.projectId;
  const sessionId = params.sessionId;

  if (!hasScopeValue(tenantId) || !hasScopeValue(projectId) || !hasScopeValue(sessionId)) {
    log.warn('pii-token-vault-flush-skipped-missing-scope', {
      hasTenantId: hasScopeValue(tenantId),
      hasProjectId: hasScopeValue(projectId),
      hasSessionId: hasScopeValue(sessionId),
    });
    return { flushed: 0, skipped: true, reason: 'missingScope' };
  }

  if (params.revealable === false) {
    return { flushed: 0, skipped: true, reason: 'notRevealable' };
  }

  const scope: ScopedPIITokenVaultParams = {
    tenantId,
    projectId,
    sessionId,
  };

  const now = params.now ?? Date.now;
  const expireAt =
    params.expiresAt ?? new Date(now() + DEFAULT_DURABLE_PII_TOKEN_VAULT_RETENTION_MS);
  const tokens = params.vault.listTokens();

  const docs = tokens.map((token) =>
    buildVaultInsert(token, scope, {
      patternConfigs: params.patternConfigs,
      source: params.source,
      revealable: true,
      expireAt,
    }),
  );

  try {
    const repository = params.repository ?? (await loadDefaultRepository());
    await repository.insertMany(docs, { ordered: false });
    log.info('pii-token-vault-flushed', {
      tenantId: params.tenantId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      count: docs.length,
    });
    return { flushed: docs.length, skipped: false };
  } catch (err) {
    const duplicateCount = countDuplicateKeyErrors(err);
    if (duplicateCount > 0 && !hasNonDuplicateWriteErrors(err)) {
      const flushed = Math.max(0, docs.length - duplicateCount);
      log.info('pii-token-vault-duplicates-ignored', {
        tenantId: params.tenantId,
        projectId: params.projectId,
        sessionId: params.sessionId,
        duplicateCount,
        flushed,
      });
      return { flushed, skipped: false, duplicateCount };
    }

    log.error('pii-token-vault-flush-failed', {
      tenantId: params.tenantId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { flushed: 0, skipped: true, reason: 'insertFailed' };
  }
}

export async function flushAndClearSessionPIIVault(
  session: SessionPIIVaultFlushTarget,
  options: Pick<
    FlushPIIVaultToDurableStoreParams,
    'repository' | 'source' | 'expiresAt' | 'now'
  > = {},
): Promise<FlushPIIVaultToDurableStoreResult> {
  if (!session.piiVault) {
    return { flushed: 0, skipped: true, reason: 'missingVault' };
  }

  try {
    return await flushPIIVaultToDurableStore({
      tenantId: session.tenantId,
      projectId: session.projectId,
      sessionId: session.id,
      vault: session.piiVault,
      patternConfigs: session.piiPatternConfigs,
      revealable: session.piiRedactionConfig?.enabled !== false,
      ...options,
    });
  } catch (err) {
    log.error('pii-token-vault-terminal-flush-failed', {
      tenantId: session.tenantId,
      projectId: session.projectId,
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { flushed: 0, skipped: true, reason: 'insertFailed' };
  } finally {
    session.piiVault.clear();
  }
}
