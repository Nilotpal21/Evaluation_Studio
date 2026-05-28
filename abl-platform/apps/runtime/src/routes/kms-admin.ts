/**
 * KMS Admin Route
 *
 * REST API for tenant KMS configuration management.
 *
 * Routes:
 *   GET    /api/tenants/:tenantId/kms/config        — Get tenant KMS config
 *   PUT    /api/tenants/:tenantId/kms/config        — Update tenant KMS config
 *   POST   /api/tenants/:tenantId/kms/validate      — Validate external endpoint
 *   GET    /api/tenants/:tenantId/kms/keys           — List DEKs for tenant
 *   POST   /api/tenants/:tenantId/kms/keys/rotate    — Force-rotate DEKs
 *   GET    /api/tenants/:tenantId/kms/audit           — Query KMS audit log
 *   GET    /api/tenants/:tenantId/kms/health          — KMS health for tenant
 *
 * Middleware: authMiddleware → tenantRateLimit → requirePermission('kms:admin')
 *
 * Mount: /api/tenants/:tenantId/kms
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { requireFeature } from '../middleware/feature-gate.js';
import { z } from 'zod';
import { toClickHouseDateTime } from '@agent-platform/database/clickhouse';

const log = createLogger('kms-admin-route');

type ClickHouseQueryParam = string | number;

interface KMSAuditSummary {
  total: number;
  successCount: number;
  failureCount: number;
  uniqueKeys: number;
  uniqueActors: number;
  avgLatencyMs: number | null;
  lastEventAt: string | null;
}

interface KMSKeysSummary {
  total: number;
  activeCount: number;
  decryptOnlyCount: number;
  destroyedCount: number;
  expiringSoonCount: number;
  latestCreatedAt: string | null;
}

interface KMSMigrationHealth {
  migrationActive: boolean;
  cryptoVerified: boolean;
  legacyLocalDekCount: number;
  implicitLocalMetadataCount: number;
  driftedDekCount: number;
  authConfigDependencyCount: number;
  localMasterKeyStillRequired: boolean;
  dekMigrationComplete: boolean;
  warnings: string[];
}

function describeProviderType(providerType: string): string {
  switch (providerType) {
    case 'aws-kms':
      return 'AWS KMS';
    case 'azure-keyvault':
      return 'Azure Key Vault';
    case 'azure-managed-hsm':
      return 'Azure Managed HSM';
    case 'gcp-cloud-kms':
      return 'Google Cloud KMS';
    case 'external':
      return 'external KMS';
    case 'local':
      return 'local KMS';
    default:
      return providerType;
  }
}

async function getPlatformDefaultSummary(): Promise<{ message: string }> {
  try {
    const { KMSResolver } = await import('@agent-platform/database/kms');
    const { provider } = KMSResolver.getPlatformDefault();
    return {
      message: `Using platform default encryption (${describeProviderType(provider.providerType)} provider)`,
    };
  } catch (err) {
    log.warn('Failed to resolve platform default KMS provider for admin response', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      message: 'Using platform default encryption',
    };
  }
}

function parsePositiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

// Removed local formatClickHouseTimestamp — use centralized toClickHouseDateTime from @agent-platform/database

function normalizeAuditBoundary(value: unknown, boundary: 'start' | 'end'): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const trimmed = value.trim();
  const dateOnlyMatch = /^\d{4}-\d{2}-\d{2}$/.exec(trimmed);
  if (dateOnlyMatch) {
    const suffix = boundary === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
    return toClickHouseDateTime(new Date(`${trimmed}${suffix}`));
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return toClickHouseDateTime(parsed);
}

function parseAuditSuccessFilter(value: unknown): 0 | 1 | null {
  if (typeof value !== 'string') {
    return null;
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'success':
      return 1;
    case '0':
    case 'false':
    case 'failure':
    case 'failed':
      return 0;
    default:
      return null;
  }
}

function parseNumericResult(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function buildKMSAuditWhereClause(params: {
  tenantId: string;
  operation?: string;
  success?: 0 | 1 | null;
  startDate?: string | null;
  endDate?: string | null;
}): { conditions: string[]; queryParams: Record<string, ClickHouseQueryParam> } {
  const conditions = ['tenant_id = {tenantId:String}'];
  const queryParams: Record<string, ClickHouseQueryParam> = {
    tenantId: params.tenantId,
  };

  if (params.operation) {
    conditions.push('operation = {operation:String}');
    queryParams.operation = params.operation;
  }

  if (params.success !== null && params.success !== undefined) {
    conditions.push('success = {success:UInt8}');
    queryParams.success = params.success;
  }

  if (params.startDate) {
    conditions.push('timestamp >= {startDate:DateTime64(3)}');
    queryParams.startDate = params.startDate;
  }

  if (params.endDate) {
    conditions.push('timestamp <= {endDate:DateTime64(3)}');
    queryParams.endDate = params.endDate;
  }

  return { conditions, queryParams };
}

function normalizeKMSAuditSummary(row: Record<string, unknown> | undefined): KMSAuditSummary {
  return {
    total: parseNumericResult(row?.total),
    successCount: parseNumericResult(row?.success_count),
    failureCount: parseNumericResult(row?.failure_count),
    uniqueKeys: parseNumericResult(row?.unique_keys),
    uniqueActors: parseNumericResult(row?.unique_actors),
    avgLatencyMs:
      row?.avg_latency_ms == null || row.avg_latency_ms === ''
        ? null
        : parseNumericResult(row.avg_latency_ms),
    lastEventAt:
      typeof row?.last_event_at === 'string' && row.last_event_at ? row.last_event_at : null,
  };
}

// ---------------------------------------------------------------------------
// Zod schemas for PUT /config
// ---------------------------------------------------------------------------

const KMSProviderRefSchema = z.object({
  providerType: z.enum([
    'local',
    'aws-kms',
    'azure-keyvault',
    'azure-managed-hsm',
    'gcp-cloud-kms',
    'external',
  ]),
  keyId: z.string().min(1, 'keyId is required'),
  region: z.string().nullable().optional().default(null),
  vaultUrl: z.string().nullable().optional().default(null),
  externalEndpoint: z.string().nullable().optional().default(null),
  authMethod: z
    .enum([
      'default-credentials',
      'service-account',
      'managed-identity',
      'api-key',
      'mtls',
      'oauth2',
      'hmac-sha256',
    ])
    .nullable()
    .optional()
    .default(null),
  // Raw credentials from the client — will be encrypted before storage
  authConfig: z.record(z.string()).nullable().optional().default(null),
});

const KMSEnvironmentOverrideSchema = z.object({
  environment: z.string().min(1),
  provider: KMSProviderRefSchema,
});

const PutConfigBodySchema = z.object({
  defaultProvider: KMSProviderRefSchema.nullable().optional(),
  dekRetentionDays: z.union([z.number().int().min(1).max(3650), z.null()]).optional(),
  dekEpochIntervalHours: z.number().int().min(12).max(8760).optional(),
  dekMaxUsageCount: z.number().int().min(1).optional(),
  kekRotationPeriodDays: z.number().int().min(1).max(3650).optional(),
  environments: z.array(KMSEnvironmentOverrideSchema).optional(),
  reencryption: z
    .object({
      enabled: z.boolean().optional(),
      concurrency: z.number().int().min(1).max(10).optional(),
      batchSize: z.number().int().min(1).max(1000).optional(),
      maxRetries: z.number().int().min(0).max(10).optional(),
    })
    .optional(),
  byokEnabled: z.boolean().optional(),
  byopEnabled: z.boolean().optional(),
  complianceLevel: z.enum(['standard', 'pci-dss', 'hipaa', 'fips-140-3']).optional(),
  failurePolicy: z.enum(['fail-closed', 'graceful-degradation']).optional(),
});

type ParsedKMSProviderRef = z.infer<typeof KMSProviderRefSchema>;
type ParsedKMSEnvironmentOverride = z.infer<typeof KMSEnvironmentOverrideSchema>;

class KMSConfigConflictError extends Error {
  constructor(message = 'KMS configuration was modified concurrently') {
    super(message);
    this.name = 'KMSConfigConflictError';
  }
}

class KMSConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KMSConfigValidationError';
  }
}

class KMSConfigPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'KMSConfigPolicyError';
    this.code = code;
  }
}

function assertValidUrl(value: string | null | undefined, field: string): void {
  if (!value) {
    return;
  }

  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('invalid protocol');
    }
  } catch {
    throw new KMSConfigValidationError(`${field} must be a valid URL`);
  }
}

function assertProviderShape(
  provider: ParsedKMSProviderRef | null | undefined,
  scopeLabel: string,
): void {
  if (!provider) {
    return;
  }

  assertValidUrl(provider.vaultUrl, `${scopeLabel} vaultUrl`);
  assertValidUrl(provider.externalEndpoint, `${scopeLabel} externalEndpoint`);

  switch (provider.providerType) {
    case 'aws-kms':
      if (!provider.region?.trim()) {
        throw new KMSConfigValidationError(`${scopeLabel} AWS KMS provider requires region`);
      }
      return;
    case 'azure-keyvault':
    case 'azure-managed-hsm':
      if (!provider.vaultUrl?.trim()) {
        throw new KMSConfigValidationError(
          `${scopeLabel} ${provider.providerType} provider requires vaultUrl`,
        );
      }
      return;
    case 'external':
      if (!provider.externalEndpoint?.trim()) {
        throw new KMSConfigValidationError(
          `${scopeLabel} external KMS provider requires externalEndpoint`,
        );
      }
      if (!provider.authMethod) {
        throw new KMSConfigValidationError(
          `${scopeLabel} external KMS provider requires authMethod`,
        );
      }
      return;
    case 'gcp-cloud-kms':
    case 'local':
      return;
    default:
      throw new KMSConfigValidationError(
        `${scopeLabel} has unsupported provider type ${provider.providerType}`,
      );
  }
}

function resolveProviderPolicy(
  existingConfig: Record<string, any> | null,
  body: Record<string, any>,
): {
  byokEnabled: boolean;
  byopEnabled: boolean;
} {
  return {
    byokEnabled: body.byokEnabled ?? existingConfig?.byokEnabled ?? false,
    byopEnabled: body.byopEnabled ?? existingConfig?.byopEnabled ?? false,
  };
}

function assertProviderAllowedByPolicy(
  provider: ParsedKMSProviderRef | null | undefined,
  policy: { byokEnabled: boolean; byopEnabled: boolean },
  scopeLabel: string,
): void {
  if (!provider || provider.providerType === 'local') {
    return;
  }

  if (provider.providerType === 'external' && !policy.byopEnabled) {
    throw new KMSConfigPolicyError(
      'KMS_BYOP_DISABLED',
      `${scopeLabel} external KMS provider requires byopEnabled to be true`,
    );
  }

  if (provider.providerType !== 'external' && !policy.byokEnabled) {
    throw new KMSConfigPolicyError(
      'KMS_BYOK_DISABLED',
      `${scopeLabel} cloud KMS provider requires byokEnabled to be true`,
    );
  }
}

function assertUniqueEnvironmentOverrides(
  environments: Array<{ environment: string }>,
  scopeLabel: string,
): void {
  const seen = new Set<string>();
  for (const entry of environments) {
    if (seen.has(entry.environment)) {
      throw new KMSConfigValidationError(
        `${scopeLabel} contains duplicate environment override for ${entry.environment}`,
      );
    }
    seen.add(entry.environment);
  }
}

async function prepareProviderForStorage(
  provider: ParsedKMSProviderRef | null | undefined,
  existingProvider: Record<string, unknown> | null | undefined,
  scopeLabel: string,
  policy: { byokEnabled: boolean; byopEnabled: boolean },
): Promise<Record<string, unknown> | null> {
  if (provider === undefined) {
    return (existingProvider as Record<string, unknown> | null | undefined) ?? null;
  }

  assertProviderShape(provider, scopeLabel);
  assertProviderAllowedByPolicy(provider, policy, scopeLabel);

  return encryptProviderForStorage(
    provider ?? null,
    (existingProvider as Record<string, unknown> | null | undefined) ?? null,
  );
}

async function prepareEnvironmentOverridesForStorage(params: {
  environments: ParsedKMSEnvironmentOverride[] | undefined;
  existingEnvironments: any[];
  scopeLabel: string;
  policy: { byokEnabled: boolean; byopEnabled: boolean };
}): Promise<any[]> {
  if (params.environments === undefined) {
    return upsertEnvironmentOverrides([], params.existingEnvironments ?? []);
  }

  assertUniqueEnvironmentOverrides(params.environments, params.scopeLabel);

  return Promise.all(
    params.environments.map(async (entry) => {
      const existingEnvironment = params.existingEnvironments?.find(
        (candidate: any) => candidate.environment === entry.environment,
      );

      return {
        environment: entry.environment,
        provider: await prepareProviderForStorage(
          entry.provider,
          existingEnvironment?.provider ?? null,
          `${params.scopeLabel} environment ${entry.environment}`,
          params.policy,
        ),
      };
    }),
  );
}

async function persistTenantKMSConfigUpdate(params: {
  tenantId: string;
  existingConfig: Record<string, any> | null;
  nextFields: Record<string, unknown>;
}): Promise<any> {
  const { TenantKMSConfig } = await import('@agent-platform/database/models');

  // Optimistic concurrency via `_v`. Pre-existing docs from older platform
  // versions may not have `_v` set — in that case we fall back to an unguarded
  // update keyed only on tenantId so legitimate writes don't start failing
  // with 409 after this code rolls out.
  const existingVersion = params.existingConfig?._v;
  const filter =
    params.existingConfig && typeof existingVersion === 'number'
      ? { tenantId: params.tenantId, _v: existingVersion }
      : { tenantId: params.tenantId };

  const updated = await TenantKMSConfig.findOneAndUpdate(
    filter,
    {
      $set: {
        tenantId: params.tenantId,
        ...params.nextFields,
      },
      $inc: { _v: 1 },
    },
    { upsert: !params.existingConfig, new: true, lean: true },
  );

  if (!updated) {
    throw new KMSConfigConflictError();
  }

  return updated;
}

function removeEnvironmentOverride(environments: any[], environment: string): any[] {
  return (environments ?? []).filter((entry: any) => entry.environment !== environment);
}

function removeProjectOverride(projects: any[], projectId: string): any[] {
  return normalizeProjectOverrides(projects ?? []).filter(
    (entry: any) => entry.projectId !== projectId,
  );
}

const router: RouterType = Router({ mergeParams: true });

// Middleware chain
router.use(authMiddleware);
router.use(tenantRateLimit('request'));
// Feature gate: KMS BYOK requires ENTERPRISE tier or deal-level feature
router.use(requireFeature('kms_byok'));

// MEDIUM-2: Validate that req.params.tenantId matches the authenticated tenant.
// Without this, a user from tenant A could manage tenant B's KMS config.
router.use((req, res, next) => {
  const paramTenantId = req.params.tenantId;
  const authTenantId = (req as any).tenantContext?.tenantId;
  if (paramTenantId && authTenantId && paramTenantId !== authTenantId) {
    log.warn('Tenant mismatch in KMS admin route', {
      paramTenantId,
      authTenantId,
      userId: (req as any).tenantContext?.userId,
    });
    // Return 404 per platform principle — cross-scope access returns 404 to avoid leaking existence
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
    return;
  }
  next();
});

// =============================================================================
// GET /config — Get tenant KMS configuration
// =============================================================================

router.get('/config', requirePermission('kms:admin'), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { TenantKMSConfig } = await import('@agent-platform/database/models');

    const config = await TenantKMSConfig.findOne({ tenantId }).lean();

    if (!config) {
      const platformDefault = await getPlatformDefaultSummary();
      return res.json({
        success: true,
        data: {
          tenantId,
          configured: false,
          usingDefault: true,
          message: platformDefault.message,
        },
      });
    }

    // Redact sensitive fields
    const sanitized = sanitizeConfig(config);
    res.json({ success: true, data: { tenantId, configured: true, ...sanitized } });
  } catch (err) {
    log.error('Failed to get KMS config', {
      tenantId: req.params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KMS_CONFIG_ERROR', message: 'Failed to retrieve KMS configuration' },
    });
  }
});

router.get('/config/resolve', requirePermission('kms:admin'), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const projectId =
      typeof req.query.projectId === 'string' && req.query.projectId.trim()
        ? req.query.projectId.trim()
        : '_tenant';
    const environment =
      typeof req.query.environment === 'string' && req.query.environment.trim()
        ? req.query.environment.trim()
        : '_shared';

    const { TenantKMSConfig } = await import('@agent-platform/database/models');
    const tenantConfig = await TenantKMSConfig.findOne({ tenantId }).lean();
    const { getGlobalKMSResolver, KMSResolver } = await import('@agent-platform/database/kms');
    const resolver = getGlobalKMSResolver() ?? new KMSResolver();
    const resolved = await resolver.resolve(tenantId, projectId, environment);

    const projectOverride = tenantConfig?.projects?.find(
      (entry: any) => entry.projectId === projectId,
    );
    const projectEnvironmentOverride = projectOverride?.environments?.find(
      (entry: any) => entry.environment === environment,
    );
    const tenantEnvironmentOverride = tenantConfig?.environments?.find(
      (entry: any) => entry.environment === environment,
    );
    const source = projectEnvironmentOverride?.provider
      ? 'project_environment'
      : projectOverride?.defaultProvider
        ? 'project_default'
        : tenantEnvironmentOverride?.provider
          ? 'tenant_environment'
          : tenantConfig?.defaultProvider
            ? 'tenant_default'
            : 'platform_default';

    const chain = [
      {
        source: 'platform_default',
        matched: source === 'platform_default',
        provider: source === 'platform_default' ? sanitizeProviderRef(resolved.provider) : null,
      },
      {
        source: 'tenant_default',
        matched: source === 'tenant_default',
        provider: sanitizeProviderRef(tenantConfig?.defaultProvider),
      },
      {
        source: 'tenant_environment',
        matched: source === 'tenant_environment',
        environment,
        provider: sanitizeProviderRef(tenantEnvironmentOverride?.provider),
      },
      {
        source: 'project_default',
        matched: source === 'project_default',
        projectId,
        provider: sanitizeProviderRef(projectOverride?.defaultProvider),
      },
      {
        source: 'project_environment',
        matched: source === 'project_environment',
        projectId,
        environment,
        provider: sanitizeProviderRef(projectEnvironmentOverride?.provider),
      },
    ];

    res.json({
      success: true,
      data: {
        tenantId,
        projectId,
        environment,
        configured: Boolean(tenantConfig),
        source,
        provider: sanitizeProviderRef(resolved.provider),
        keyId: resolved.keyId,
        failurePolicy: resolved.failurePolicy,
        sourceConfigVersion: resolved.sourceConfigVersion,
        chain,
      },
    });
  } catch (err) {
    log.error('Failed to resolve effective KMS config', {
      tenantId: req.params.tenantId,
      projectId: req.query.projectId,
      environment: req.query.environment,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KMS_CONFIG_ERROR', message: 'Failed to resolve effective KMS configuration' },
    });
  }
});

// =============================================================================
// PUT /config — Update tenant KMS configuration
// =============================================================================

router.put('/config', requirePermission('kms:admin'), async (req, res) => {
  const startedAt = Date.now();
  try {
    const { tenantId } = req.params;
    const body = req.body;

    // Zod validation
    const parseResult = PutConfigBodySchema.safeParse(body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'KMS_VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parseResult.error.flatten().fieldErrors,
        },
      });
    }
    const validated = parseResult.data;

    const { TenantKMSConfig } = await import('@agent-platform/database/models');

    const existing = (await TenantKMSConfig.findOne({ tenantId }).lean()) as Record<
      string,
      any
    > | null;

    const policy = resolveProviderPolicy(existing, validated);
    const providerToStore = await prepareProviderForStorage(
      validated.defaultProvider,
      existing?.defaultProvider ?? null,
      'Tenant default provider',
      policy,
    );

    // Build $set with merge semantics: only override fields that were
    // explicitly sent in the request body. Preserves pre-scoped-KMS behavior —
    // we must NOT rewrite `projects` here, and we only rewrite `environments`
    // if the caller included it, to avoid silently normalizing/dropping
    // existing customer data on unrelated PUTs.
    const nextFields: Record<string, unknown> = {};

    nextFields.defaultProvider = providerToStore ?? existing?.defaultProvider ?? null;
    nextFields.dekRetentionDays =
      validated.dekRetentionDays !== undefined
        ? validated.dekRetentionDays
        : (existing?.dekRetentionDays ?? null);
    nextFields.dekEpochIntervalHours =
      validated.dekEpochIntervalHours ?? existing?.dekEpochIntervalHours ?? 24;
    nextFields.dekMaxUsageCount =
      validated.dekMaxUsageCount ?? existing?.dekMaxUsageCount ?? 1073741824;
    nextFields.kekRotationPeriodDays =
      validated.kekRotationPeriodDays ?? existing?.kekRotationPeriodDays ?? 365;
    nextFields.reencryption = {
      enabled: validated.reencryption?.enabled ?? existing?.reencryption?.enabled ?? true,
      concurrency: validated.reencryption?.concurrency ?? existing?.reencryption?.concurrency ?? 1,
      batchSize: validated.reencryption?.batchSize ?? existing?.reencryption?.batchSize ?? 50,
      maxRetries: validated.reencryption?.maxRetries ?? existing?.reencryption?.maxRetries ?? 3,
    };
    nextFields.byokEnabled = policy.byokEnabled;
    nextFields.byopEnabled = policy.byopEnabled;
    nextFields.complianceLevel =
      validated.complianceLevel ?? existing?.complianceLevel ?? 'standard';
    nextFields.failurePolicy = validated.failurePolicy ?? existing?.failurePolicy ?? 'fail-closed';

    if (validated.environments !== undefined) {
      nextFields.environments = await prepareEnvironmentOverridesForStorage({
        environments: validated.environments,
        existingEnvironments: existing?.environments ?? [],
        scopeLabel: 'Tenant config',
        policy,
      });
    }

    await persistTenantKMSConfigUpdate({
      tenantId,
      existingConfig: existing,
      nextFields,
    });

    const syncStatus = await syncTenantKMSConfigActivation(tenantId, 'tenant config update');

    // Audit log
    try {
      const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
      logKMSAuditEvent({
        tenantId,
        operation: 'config_update',
        keyId: validated.defaultProvider?.keyId || 'none',
        providerType: validated.defaultProvider?.providerType || 'local',
        actorId: (req as any).tenantContext?.userId || 'unknown',
        actorType: 'user',
        actorIp: getActorIp(req),
        success: true,
        latencyMs: Date.now() - startedAt,
        metadata: {
          configActive: syncStatus.configActive,
        },
      });
    } catch (err) {
      // Audit logging is non-fatal
      log.warn('KMS audit log write failed after config update', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log.info('KMS config updated', { tenantId });
    const data: Record<string, any> = {
      ...(await loadSanitizedTenantKMSConfig(tenantId)),
      configActive: syncStatus.configActive,
    };
    if (syncStatus.activationWarning) data.activationWarning = syncStatus.activationWarning;
    if (syncStatus.propagationWarning) data.propagationWarning = syncStatus.propagationWarning;

    res.json({ success: true, data });
  } catch (err) {
    if (err instanceof KMSConfigValidationError) {
      return res.status(400).json({
        success: false,
        error: { code: 'KMS_VALIDATION_ERROR', message: err.message },
      });
    }
    if (err instanceof KMSConfigPolicyError) {
      return res.status(403).json({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    if (err instanceof KMSConfigConflictError) {
      return res.status(409).json({
        success: false,
        error: { code: 'KMS_CONFIG_CONFLICT', message: err.message },
      });
    }
    try {
      const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
      logKMSAuditEvent({
        tenantId: req.params.tenantId,
        operation: 'config_update',
        keyId: req.body?.defaultProvider?.keyId || 'none',
        providerType: req.body?.defaultProvider?.providerType || 'local',
        actorId: (req as any).tenantContext?.userId || 'unknown',
        actorType: 'user',
        actorIp: getActorIp(req),
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
      });
    } catch (auditErr) {
      log.warn('KMS audit log write failed after config update failure', {
        tenantId: req.params.tenantId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    log.error('Failed to update KMS config', {
      tenantId: req.params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KMS_CONFIG_ERROR', message: 'Failed to update KMS configuration' },
    });
  }
});

const TenantEnvironmentConfigSchema = z.object({
  provider: KMSProviderRefSchema,
});

router.put(
  '/config/environments/:environment',
  requirePermission('kms:admin'),
  async (req, res) => {
    const startedAt = Date.now();
    try {
      const { tenantId, environment } = req.params;
      const parsed = TenantEnvironmentConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'KMS_VALIDATION_ERROR',
            message: parsed.error.issues.map((issue) => issue.message).join(', '),
          },
        });
      }

      const { TenantKMSConfig } = await import('@agent-platform/database/models');
      const existingConfig = (await TenantKMSConfig.findOne({ tenantId }).lean()) as Record<
        string,
        any
      > | null;
      const policy = resolveProviderPolicy(existingConfig, {});
      const existingEnvironment = (existingConfig?.environments ?? []).find(
        (entry: any) => entry.environment === environment,
      );
      const providerToStore = await prepareProviderForStorage(
        parsed.data.provider,
        existingEnvironment?.provider ?? null,
        `Tenant environment ${environment}`,
        policy,
      );
      const nextEnvironments = upsertEnvironmentOverride(existingConfig?.environments ?? [], {
        environment,
        provider: providerToStore,
      });

      // Only rewrite the `environments` field. `projects` and scalar tenant
      // settings are left untouched to avoid silently normalizing or
      // overwriting unrelated customer data on a scoped PUT.
      const nextFieldsForScopedPut: Record<string, unknown> = {
        environments: nextEnvironments,
      };
      if (!existingConfig) {
        // Upsert path: seed required tenant-level defaults so the new document is
        // coherent. Matches pre-scoped-KMS defaults.
        nextFieldsForScopedPut.defaultProvider = null;
        nextFieldsForScopedPut.projects = [];
        nextFieldsForScopedPut.dekRetentionDays = null;
        nextFieldsForScopedPut.dekEpochIntervalHours = 24;
        nextFieldsForScopedPut.dekMaxUsageCount = 1073741824;
        nextFieldsForScopedPut.kekRotationPeriodDays = 365;
        nextFieldsForScopedPut.reencryption = {
          enabled: true,
          concurrency: 1,
          batchSize: 50,
          maxRetries: 3,
        };
        nextFieldsForScopedPut.byokEnabled = false;
        nextFieldsForScopedPut.byopEnabled = false;
        nextFieldsForScopedPut.complianceLevel = 'standard';
        nextFieldsForScopedPut.failurePolicy = 'fail-closed';
      }

      await persistTenantKMSConfigUpdate({
        tenantId,
        existingConfig,
        nextFields: nextFieldsForScopedPut,
      });

      const syncStatus = await syncTenantKMSConfigActivation(
        tenantId,
        'tenant environment config update',
      );

      try {
        const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
        logKMSAuditEvent({
          tenantId,
          operation: 'tenant_environment_config_update',
          keyId: parsed.data.provider.keyId,
          providerType: parsed.data.provider.providerType,
          environment,
          actorId: (req as any).tenantContext?.userId || 'unknown',
          actorType: 'user',
          actorIp: getActorIp(req),
          success: syncStatus.configActive,
          errorMessage: syncStatus.activationWarning,
          latencyMs: Date.now() - startedAt,
          metadata: {
            configActive: syncStatus.configActive,
          },
        });
      } catch (auditErr) {
        log.warn('KMS audit log write failed after tenant environment config update', {
          tenantId,
          environment,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }

      const data: Record<string, unknown> = {
        ...(await loadSanitizedTenantKMSConfig(tenantId)),
        configActive: syncStatus.configActive,
        environment,
      };
      if (syncStatus.activationWarning) data.activationWarning = syncStatus.activationWarning;
      if (syncStatus.propagationWarning) data.propagationWarning = syncStatus.propagationWarning;
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof KMSConfigValidationError) {
        return res.status(400).json({
          success: false,
          error: { code: 'KMS_VALIDATION_ERROR', message: err.message },
        });
      }
      if (err instanceof KMSConfigPolicyError) {
        return res.status(403).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      if (err instanceof KMSConfigConflictError) {
        return res.status(409).json({
          success: false,
          error: { code: 'KMS_CONFIG_CONFLICT', message: err.message },
        });
      }
      log.error('Failed to update tenant environment KMS config', {
        tenantId: req.params.tenantId,
        environment: req.params.environment,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'KMS_CONFIG_ERROR', message: 'Failed to update tenant environment config' },
      });
    }
  },
);

router.delete(
  '/config/environments/:environment',
  requirePermission('kms:admin'),
  async (req, res) => {
    const startedAt = Date.now();
    try {
      const { tenantId, environment } = req.params;
      const { TenantKMSConfig } = await import('@agent-platform/database/models');
      const existingConfig = (await TenantKMSConfig.findOne({ tenantId }).lean()) as Record<
        string,
        any
      > | null;

      if (!existingConfig) {
        return res.status(404).json({
          success: false,
          error: { code: 'KMS_CONFIG_NOT_FOUND', message: 'KMS config not found' },
        });
      }

      const nextEnvironments = removeEnvironmentOverride(
        existingConfig.environments ?? [],
        environment,
      );
      if (nextEnvironments.length === (existingConfig.environments ?? []).length) {
        return res.status(404).json({
          success: false,
          error: { code: 'KMS_OVERRIDE_NOT_FOUND', message: 'Environment override not found' },
        });
      }

      await persistTenantKMSConfigUpdate({
        tenantId,
        existingConfig,
        nextFields: {
          environments: nextEnvironments,
        },
      });

      const syncStatus = await syncTenantKMSConfigActivation(
        tenantId,
        'tenant environment config delete',
      );
      try {
        const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
        logKMSAuditEvent({
          tenantId,
          operation: 'tenant_environment_config_delete',
          keyId: existingConfig.defaultProvider?.keyId || 'none',
          providerType: existingConfig.defaultProvider?.providerType || 'system',
          environment,
          actorId: (req as any).tenantContext?.userId || 'unknown',
          actorType: 'user',
          actorIp: getActorIp(req),
          success: syncStatus.configActive,
          errorMessage: syncStatus.activationWarning,
          latencyMs: Date.now() - startedAt,
          metadata: {
            configActive: syncStatus.configActive,
          },
        });
      } catch (auditErr) {
        log.warn('KMS audit log write failed after tenant environment config delete', {
          tenantId,
          environment,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }
      const data: Record<string, unknown> = {
        ...(await loadSanitizedTenantKMSConfig(tenantId)),
        configActive: syncStatus.configActive,
        environment,
      };
      if (syncStatus.activationWarning) data.activationWarning = syncStatus.activationWarning;
      if (syncStatus.propagationWarning) data.propagationWarning = syncStatus.propagationWarning;
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof KMSConfigConflictError) {
        return res.status(409).json({
          success: false,
          error: { code: 'KMS_CONFIG_CONFLICT', message: err.message },
        });
      }
      try {
        const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
        logKMSAuditEvent({
          tenantId: req.params.tenantId,
          operation: 'tenant_environment_config_delete',
          keyId: 'none',
          providerType: 'system',
          environment: req.params.environment,
          actorId: (req as any).tenantContext?.userId || 'unknown',
          actorType: 'user',
          actorIp: getActorIp(req),
          success: false,
          errorMessage: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - startedAt,
        });
      } catch (auditErr) {
        log.warn('KMS audit log write failed after tenant environment config delete failure', {
          tenantId: req.params.tenantId,
          environment: req.params.environment,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }
      log.error('Failed to delete tenant environment KMS config', {
        tenantId: req.params.tenantId,
        environment: req.params.environment,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'KMS_CONFIG_ERROR', message: 'Failed to delete tenant environment config' },
      });
    }
  },
);

// =============================================================================
// POST /validate — Validate external KMS endpoint
// =============================================================================

router.post('/validate', requirePermission('kms:admin'), async (req, res) => {
  const startedAt = Date.now();
  try {
    const { tenantId } = req.params;
    const body = req.body;

    if (!body?.endpoint || !body?.authMethod) {
      return res.status(400).json({
        success: false,
        error: { code: 'KMS_VALIDATION_ERROR', message: 'endpoint and authMethod required' },
      });
    }

    const { validateExternalKMSEndpoint } =
      await import('../services/kms/external-kms-validator.js');

    const result = await validateExternalKMSEndpoint(body, {
      roundTripTest: body.roundTripTest !== false,
      testKeyId: body.testKeyId,
      maxLatencyMs: body.maxLatencyMs,
    });

    try {
      const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
      logKMSAuditEvent({
        tenantId,
        operation: 'external_kms_validation',
        keyId: body.testKeyId || body.keyId || 'validation',
        providerType: 'external',
        actorId: (req as any).tenantContext?.userId || 'unknown',
        actorType: 'user',
        actorIp: getActorIp(req),
        success: result.valid,
        errorMessage: result.valid ? undefined : result.errors.join('; '),
        latencyMs: Date.now() - startedAt,
        metadata: {
          endpoint: body.endpoint,
          warnings: result.warnings,
        },
      });
    } catch (auditErr) {
      log.warn('KMS audit log write failed after external validation success', {
        tenantId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    try {
      const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
      logKMSAuditEvent({
        tenantId: req.params.tenantId,
        operation: 'external_kms_validation',
        keyId: req.body?.testKeyId || req.body?.keyId || 'validation',
        providerType: 'external',
        actorId: (req as any).tenantContext?.userId || 'unknown',
        actorType: 'user',
        actorIp: getActorIp(req),
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
        metadata: {
          endpoint: req.body?.endpoint,
        },
      });
    } catch (auditErr) {
      log.warn('KMS audit log write failed after external validation failure', {
        tenantId: req.params.tenantId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    log.error('Endpoint validation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KMS_VALIDATION_ERROR', message: 'Validation failed' },
    });
  }
});

// =============================================================================
// GET /keys — List DEKs for tenant
// =============================================================================

router.get('/keys', requirePermission('kms:admin'), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { status, projectId, environment, limit: limitStr, offset: offsetStr } = req.query;

    const { DEKEntry } = await import('@agent-platform/database/models');

    const baseQuery: Record<string, any> = { tenantId };
    if (projectId) baseQuery.projectId = projectId;
    if (environment) baseQuery.environment = environment;

    const query: Record<string, any> = { ...baseQuery };
    if (status) query.status = status;

    const limit = Math.max(parsePositiveInteger(limitStr, 25, 100), 1);
    const offset = parsePositiveInteger(offsetStr, 0, 100000);
    const now = new Date();
    const expiringSoonBoundary = new Date(Date.now() + 72 * 60 * 60 * 1000);

    const [
      entries,
      total,
      activeCount,
      decryptOnlyCount,
      destroyedCount,
      expiringSoonCount,
      projects,
      environments,
    ] = await Promise.all([
      DEKEntry.find(query)
        .select('-wrappedDek') // Never expose wrapped key material
        .sort({ createdAt: -1, epoch: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      DEKEntry.countDocuments(query),
      DEKEntry.countDocuments({
        ...baseQuery,
        status: 'active',
      }),
      DEKEntry.countDocuments({
        ...baseQuery,
        status: 'decrypt_only',
      }),
      DEKEntry.countDocuments({
        ...baseQuery,
        status: 'destroyed',
      }),
      DEKEntry.countDocuments({
        ...baseQuery,
        status: 'active',
        expiresAt: { $ne: null, $gte: now, $lte: expiringSoonBoundary },
      }),
      typeof (
        DEKEntry as {
          distinct?: (field: string, filter: Record<string, unknown>) => Promise<unknown[]>;
        }
      ).distinct === 'function'
        ? (
            DEKEntry as {
              distinct: (field: string, filter: Record<string, unknown>) => Promise<unknown[]>;
            }
          ).distinct('projectId', baseQuery)
        : Promise.resolve([]),
      typeof (
        DEKEntry as {
          distinct?: (field: string, filter: Record<string, unknown>) => Promise<unknown[]>;
        }
      ).distinct === 'function'
        ? (
            DEKEntry as {
              distinct: (field: string, filter: Record<string, unknown>) => Promise<unknown[]>;
            }
          ).distinct('environment', baseQuery)
        : Promise.resolve([]),
    ]);

    const sanitizedEntries = entries.map((entry: any) => sanitizeDEKEntry(entry));
    const latestCreatedAt = (sanitizedEntries as Array<{ createdAt?: string | null }>).reduce(
      (latest: string | null, entry) => {
        if (!entry.createdAt) {
          return latest;
        }
        if (!latest) {
          return entry.createdAt;
        }
        return new Date(entry.createdAt).getTime() > new Date(latest).getTime()
          ? entry.createdAt
          : latest;
      },
      null,
    );

    res.json({
      success: true,
      data: {
        entries: sanitizedEntries,
        total,
        limit,
        offset,
        hasMore: offset + sanitizedEntries.length < total,
        summary: {
          total,
          activeCount,
          decryptOnlyCount,
          destroyedCount,
          expiringSoonCount,
          latestCreatedAt,
        },
        filters: {
          statuses: [
            { status: 'active', count: activeCount },
            { status: 'decrypt_only', count: decryptOnlyCount },
            { status: 'destroyed', count: destroyedCount },
          ],
          projects: Array.isArray(projects)
            ? projects.filter(
                (value: unknown): value is string => typeof value === 'string' && value.length > 0,
              )
            : [],
          environments: Array.isArray(environments)
            ? environments.filter(
                (value: unknown): value is string => typeof value === 'string' && value.length > 0,
              )
            : [],
        },
      },
    });
  } catch (err) {
    log.error('Failed to list DEKs', {
      tenantId: req.params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KMS_QUERY_ERROR', message: 'Failed to list keys' },
    });
  }
});

// =============================================================================
// POST /keys/rotate — Force-rotate DEKs
// =============================================================================

router.post('/keys/rotate', requirePermission('kms:admin'), async (req, res) => {
  const startedAt = Date.now();
  try {
    const { tenantId } = req.params;

    const RotateBodySchema = z.object({
      reason: z
        .enum(['kek-age-exceeded', 'manual-rotation', 'key-compromise'])
        .optional()
        .default('manual-rotation'),
      projectId: z.string().min(1).optional(),
      environment: z.string().min(1).optional(),
    });

    const parsed = RotateBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REASON',
          message: `Invalid reason: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
        },
      });
      return;
    }

    const { reason, projectId: scopeProjectId, environment: scopeEnvironment } = parsed.data;

    const { enqueueReencryption } = await import('../services/kms/reencryption-queue.js');

    const jobId = await enqueueReencryption({
      tenantId,
      reason: reason || 'manual-rotation',
      projectId: scopeProjectId,
      environment: scopeEnvironment,
    });

    // Force-rotate DEKs — scope-aware or tenant-wide
    // MUST go through facade to evict the in-process DEK cache.
    // Direct DEKEntry.updateMany bypasses the cache, causing stale key reuse.
    let deksRotated = 0;
    const { getEncryptionFacade } = await import('@agent-platform/shared-encryption');
    const facade = getEncryptionFacade();

    if (facade) {
      deksRotated = await facade.forceRotate(tenantId, scopeProjectId, scopeEnvironment);
    } else {
      // Fallback: direct DB update (cache will be stale until TTL expires)
      const { DEKEntry } = await import('@agent-platform/database/models');
      const result = await DEKEntry.updateMany(
        buildRotationFilter(tenantId, scopeProjectId, scopeEnvironment),
        {
          $set: { status: 'decrypt_only', retiredAt: new Date() },
        },
      );
      deksRotated = result.modifiedCount;
      log.warn('Rotation without facade — DEK cache not evicted', { tenantId });
    }

    // Publish cache invalidation to all pods via Redis Pub/Sub
    try {
      const { getGlobalKMSResolver } = await import('@agent-platform/database/kms');
      const kmsResolver = getGlobalKMSResolver();
      if (kmsResolver) {
        await kmsResolver.publishInvalidation(tenantId);
        log.info('Published DEK cache invalidation after rotation', { tenantId });
      }
    } catch (err) {
      // Cache invalidation is non-fatal — TTL will expire naturally
      log.warn('DEK cache invalidation failed after rotation', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Audit log
    try {
      const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
      logKMSAuditEvent({
        tenantId,
        operation: 'force_rotate',
        keyId: 'all',
        providerType: 'system',
        actorId: (req as any).tenantContext?.userId || 'unknown',
        actorType: 'user',
        actorIp: getActorIp(req),
        success: true,
        latencyMs: Date.now() - startedAt,
        metadata: {
          deksRotated,
          reencryptionJobId: jobId,
          reason: reason || 'manual-rotation',
          projectId: scopeProjectId ?? null,
          environment: scopeEnvironment ?? null,
        },
      });
    } catch (err) {
      // Audit logging is non-fatal
      log.warn('KMS audit log write failed after rotation', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log.info('Force key rotation triggered', {
      tenantId,
      projectId: scopeProjectId,
      environment: scopeEnvironment,
      deksRotated,
      jobId,
    });

    res.json({
      success: true,
      data: {
        rotated: deksRotated,
        reencryptionJobId: jobId,
        message: `${deksRotated} DEKs moved to decrypt_only. Re-encryption job ${jobId ? 'enqueued' : 'skipped (queue unavailable)'}. DEK cache invalidated.`,
      },
    });
  } catch (err) {
    try {
      const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
      logKMSAuditEvent({
        tenantId: req.params.tenantId,
        operation: 'force_rotate',
        keyId: 'all',
        providerType: 'system',
        projectId: req.body?.projectId,
        environment: req.body?.environment,
        actorId: (req as any).tenantContext?.userId || 'unknown',
        actorType: 'user',
        actorIp: getActorIp(req),
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
        metadata: {
          reason: req.body?.reason ?? 'manual-rotation',
        },
      });
    } catch (auditErr) {
      log.warn('KMS audit log write failed after force rotation failure', {
        tenantId: req.params.tenantId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    log.error('Failed to rotate keys', {
      tenantId: req.params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KMS_ROTATION_ERROR', message: 'Failed to rotate keys' },
    });
  }
});

// =============================================================================
// PUT /config/projects/:projectId — Set project-level KMS override
// =============================================================================

const ProjectConfigSchema = z.object({
  defaultProvider: KMSProviderRefSchema.nullable().optional(),
  environments: z
    .array(
      z.object({
        environment: z.string().min(1),
        provider: KMSProviderRefSchema,
      }),
    )
    .optional(),
});

router.put('/config/projects/:projectId', requirePermission('kms:admin'), async (req, res) => {
  const startedAt = Date.now();
  try {
    const { tenantId, projectId } = req.params;

    const parsed = ProjectConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join(', '),
        },
      });
      return;
    }

    const { TenantKMSConfig } = await import('@agent-platform/database/models');
    const existingConfig = (await TenantKMSConfig.findOne({ tenantId }).lean()) as Record<
      string,
      any
    > | null;
    const policy = resolveProviderPolicy(existingConfig, {});
    const normalizedProjects = normalizeProjectOverrides(existingConfig?.projects ?? []);
    const existingProject =
      normalizedProjects.find((entry: any) => entry.projectId === projectId) ?? null;
    const nextDefaultProvider = await prepareProviderForStorage(
      parsed.data.defaultProvider,
      existingProject?.defaultProvider ?? null,
      `Project ${projectId} default provider`,
      policy,
    );
    const nextEnvironments = await prepareEnvironmentOverridesForStorage({
      environments: parsed.data.environments,
      existingEnvironments: existingProject?.environments ?? [],
      scopeLabel: `Project ${projectId}`,
      policy,
    });
    const nextProjects = upsertProjectOverride(normalizedProjects, {
      projectId,
      defaultProvider: nextDefaultProvider,
      environments: nextEnvironments,
    });

    // Scoped project PUT: only rewrite `projects`. Tenant-level fields and
    // `environments` (tenant env overrides) are left untouched. If no doc
    // exists yet, seed sensible defaults so the upsert produces a coherent
    // document.
    const nextFieldsForProjectPut: Record<string, unknown> = { projects: nextProjects };
    if (!existingConfig) {
      nextFieldsForProjectPut.defaultProvider = null;
      nextFieldsForProjectPut.environments = [];
      nextFieldsForProjectPut.dekRetentionDays = null;
      nextFieldsForProjectPut.dekEpochIntervalHours = 24;
      nextFieldsForProjectPut.dekMaxUsageCount = 1073741824;
      nextFieldsForProjectPut.kekRotationPeriodDays = 365;
      nextFieldsForProjectPut.reencryption = {
        enabled: true,
        concurrency: 1,
        batchSize: 50,
        maxRetries: 3,
      };
      nextFieldsForProjectPut.byokEnabled = false;
      nextFieldsForProjectPut.byopEnabled = false;
      nextFieldsForProjectPut.complianceLevel = 'standard';
      nextFieldsForProjectPut.failurePolicy = 'fail-closed';
    }

    await persistTenantKMSConfigUpdate({
      tenantId,
      existingConfig,
      nextFields: nextFieldsForProjectPut,
    });

    const syncStatus = await syncTenantKMSConfigActivation(tenantId, 'project config update');

    try {
      const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
      logKMSAuditEvent({
        tenantId,
        operation: 'project_config_update',
        keyId: parsed.data.defaultProvider?.keyId || 'none',
        providerType: parsed.data.defaultProvider?.providerType || 'local',
        projectId,
        actorId: (req as any).tenantContext?.userId || 'unknown',
        actorType: 'user',
        actorIp: getActorIp(req),
        success: syncStatus.configActive,
        errorMessage: syncStatus.activationWarning,
        latencyMs: Date.now() - startedAt,
        metadata: {
          configActive: syncStatus.configActive,
          environmentCount: nextEnvironments.length,
        },
      });
    } catch (auditErr) {
      log.warn('KMS audit log write failed after project config update', {
        tenantId,
        projectId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }

    log.info('Project KMS config updated', { tenantId, projectId });
    const data: Record<string, unknown> = {
      ...(await loadSanitizedTenantKMSConfig(tenantId)),
      configActive: syncStatus.configActive,
      projectId,
    };
    if (syncStatus.activationWarning) data.activationWarning = syncStatus.activationWarning;
    if (syncStatus.propagationWarning) data.propagationWarning = syncStatus.propagationWarning;
    res.json({ success: true, data });
  } catch (err) {
    if (err instanceof KMSConfigValidationError) {
      return res.status(400).json({
        success: false,
        error: { code: 'KMS_VALIDATION_ERROR', message: err.message },
      });
    }
    if (err instanceof KMSConfigPolicyError) {
      return res.status(403).json({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    if (err instanceof KMSConfigConflictError) {
      return res.status(409).json({
        success: false,
        error: { code: 'KMS_CONFIG_CONFLICT', message: err.message },
      });
    }
    try {
      const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
      logKMSAuditEvent({
        tenantId: req.params.tenantId,
        operation: 'project_config_update',
        keyId: req.body?.defaultProvider?.keyId || 'none',
        providerType: req.body?.defaultProvider?.providerType || 'local',
        projectId: req.params.projectId,
        actorId: (req as any).tenantContext?.userId || 'unknown',
        actorType: 'user',
        actorIp: getActorIp(req),
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
      });
    } catch (auditErr) {
      log.warn('KMS audit log write failed after project config update failure', {
        tenantId: req.params.tenantId,
        projectId: req.params.projectId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    log.error('Failed to update project KMS config', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update project config' },
    });
  }
});

// =============================================================================
// PUT /config/projects/:projectId/environments/:environment
// =============================================================================

const EnvConfigSchema = z.object({
  provider: KMSProviderRefSchema,
});

router.put(
  '/config/projects/:projectId/environments/:environment',
  requirePermission('kms:admin'),
  async (req, res) => {
    const startedAt = Date.now();
    try {
      const { tenantId, projectId, environment } = req.params;

      const parsed = EnvConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join(', '),
          },
        });
        return;
      }

      const { TenantKMSConfig } = await import('@agent-platform/database/models');

      // Ensure the project override exists, then upsert the environment
      const config = (await TenantKMSConfig.findOne({ tenantId }).lean()) as Record<
        string,
        any
      > | null;
      const policy = resolveProviderPolicy(config, {});
      const normalizedProjects = normalizeProjectOverrides(config?.projects ?? []);
      const projectOverride =
        normalizedProjects.find((entry: any) => entry.projectId === projectId) ?? null;
      const existingEnvironment = projectOverride?.environments?.find(
        (entry: any) => entry.environment === environment,
      );
      const providerToStore = await prepareProviderForStorage(
        parsed.data.provider,
        existingEnvironment?.provider ?? null,
        `Project ${projectId} environment ${environment}`,
        policy,
      );
      const nextProject = {
        projectId,
        defaultProvider: projectOverride?.defaultProvider ?? null,
        environments: upsertEnvironmentOverride(projectOverride?.environments ?? [], {
          environment,
          provider: providerToStore,
        }),
      };
      const nextProjects = upsertProjectOverride(normalizedProjects, nextProject);

      // Scoped project-environment PUT: only rewrite `projects`. Tenant-level
      // fields and `environments` (tenant env overrides) are left untouched.
      // If no doc exists yet, seed sensible defaults so the upsert produces
      // a coherent document.
      const nextFieldsForProjectEnvPut: Record<string, unknown> = { projects: nextProjects };
      if (!config) {
        nextFieldsForProjectEnvPut.defaultProvider = null;
        nextFieldsForProjectEnvPut.environments = [];
        nextFieldsForProjectEnvPut.dekRetentionDays = null;
        nextFieldsForProjectEnvPut.dekEpochIntervalHours = 24;
        nextFieldsForProjectEnvPut.dekMaxUsageCount = 1073741824;
        nextFieldsForProjectEnvPut.kekRotationPeriodDays = 365;
        nextFieldsForProjectEnvPut.reencryption = {
          enabled: true,
          concurrency: 1,
          batchSize: 50,
          maxRetries: 3,
        };
        nextFieldsForProjectEnvPut.byokEnabled = false;
        nextFieldsForProjectEnvPut.byopEnabled = false;
        nextFieldsForProjectEnvPut.complianceLevel = 'standard';
        nextFieldsForProjectEnvPut.failurePolicy = 'fail-closed';
      }

      await persistTenantKMSConfigUpdate({
        tenantId,
        existingConfig: config,
        nextFields: nextFieldsForProjectEnvPut,
      });

      const syncStatus = await syncTenantKMSConfigActivation(tenantId, 'environment config update');

      try {
        const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
        logKMSAuditEvent({
          tenantId,
          operation: 'environment_config_update',
          keyId: parsed.data.provider.keyId,
          providerType: parsed.data.provider.providerType,
          projectId,
          environment,
          actorId: (req as any).tenantContext?.userId || 'unknown',
          actorType: 'user',
          actorIp: getActorIp(req),
          success: syncStatus.configActive,
          errorMessage: syncStatus.activationWarning,
          latencyMs: Date.now() - startedAt,
          metadata: {
            configActive: syncStatus.configActive,
          },
        });
      } catch (auditErr) {
        log.warn('KMS audit log write failed after environment config update', {
          tenantId,
          projectId,
          environment,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }

      log.info('Environment KMS config updated', { tenantId, projectId, environment });
      const data: Record<string, unknown> = {
        ...(await loadSanitizedTenantKMSConfig(tenantId)),
        configActive: syncStatus.configActive,
        projectId,
        environment,
      };
      if (syncStatus.activationWarning) data.activationWarning = syncStatus.activationWarning;
      if (syncStatus.propagationWarning) data.propagationWarning = syncStatus.propagationWarning;
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof KMSConfigValidationError) {
        return res.status(400).json({
          success: false,
          error: { code: 'KMS_VALIDATION_ERROR', message: err.message },
        });
      }
      if (err instanceof KMSConfigPolicyError) {
        return res.status(403).json({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      if (err instanceof KMSConfigConflictError) {
        return res.status(409).json({
          success: false,
          error: { code: 'KMS_CONFIG_CONFLICT', message: err.message },
        });
      }
      try {
        const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
        logKMSAuditEvent({
          tenantId: req.params.tenantId,
          operation: 'environment_config_update',
          keyId: req.body?.provider?.keyId || 'none',
          providerType: req.body?.provider?.providerType || 'local',
          projectId: req.params.projectId,
          environment: req.params.environment,
          actorId: (req as any).tenantContext?.userId || 'unknown',
          actorType: 'user',
          actorIp: getActorIp(req),
          success: false,
          errorMessage: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - startedAt,
        });
      } catch (auditErr) {
        log.warn('KMS audit log write failed after environment config update failure', {
          tenantId: req.params.tenantId,
          projectId: req.params.projectId,
          environment: req.params.environment,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }
      log.error('Failed to update environment KMS config', {
        tenantId: req.params.tenantId,
        projectId: req.params.projectId,
        environment: req.params.environment,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update environment config' },
      });
    }
  },
);

router.delete('/config/projects/:projectId', requirePermission('kms:admin'), async (req, res) => {
  const startedAt = Date.now();
  try {
    const { tenantId, projectId } = req.params;
    const { TenantKMSConfig } = await import('@agent-platform/database/models');
    const existingConfig = (await TenantKMSConfig.findOne({ tenantId }).lean()) as Record<
      string,
      any
    > | null;

    if (!existingConfig) {
      return res.status(404).json({
        success: false,
        error: { code: 'KMS_CONFIG_NOT_FOUND', message: 'KMS config not found' },
      });
    }

    const nextProjects = removeProjectOverride(existingConfig.projects ?? [], projectId);
    if (nextProjects.length === normalizeProjectOverrides(existingConfig.projects ?? []).length) {
      return res.status(404).json({
        success: false,
        error: { code: 'KMS_OVERRIDE_NOT_FOUND', message: 'Project override not found' },
      });
    }

    await persistTenantKMSConfigUpdate({
      tenantId,
      existingConfig,
      nextFields: {
        projects: nextProjects,
      },
    });

    const syncStatus = await syncTenantKMSConfigActivation(tenantId, 'project config delete');
    try {
      const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
      logKMSAuditEvent({
        tenantId,
        operation: 'project_config_delete',
        keyId: existingConfig.defaultProvider?.keyId || 'none',
        providerType: existingConfig.defaultProvider?.providerType || 'system',
        projectId,
        actorId: (req as any).tenantContext?.userId || 'unknown',
        actorType: 'user',
        actorIp: getActorIp(req),
        success: syncStatus.configActive,
        errorMessage: syncStatus.activationWarning,
        latencyMs: Date.now() - startedAt,
        metadata: {
          configActive: syncStatus.configActive,
        },
      });
    } catch (auditErr) {
      log.warn('KMS audit log write failed after project config delete', {
        tenantId,
        projectId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    const data: Record<string, unknown> = {
      ...(await loadSanitizedTenantKMSConfig(tenantId)),
      configActive: syncStatus.configActive,
      projectId,
    };
    if (syncStatus.activationWarning) data.activationWarning = syncStatus.activationWarning;
    if (syncStatus.propagationWarning) data.propagationWarning = syncStatus.propagationWarning;
    res.json({ success: true, data });
  } catch (err) {
    if (err instanceof KMSConfigConflictError) {
      return res.status(409).json({
        success: false,
        error: { code: 'KMS_CONFIG_CONFLICT', message: err.message },
      });
    }
    try {
      const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
      logKMSAuditEvent({
        tenantId: req.params.tenantId,
        operation: 'project_config_delete',
        keyId: 'none',
        providerType: 'system',
        projectId: req.params.projectId,
        actorId: (req as any).tenantContext?.userId || 'unknown',
        actorType: 'user',
        actorIp: getActorIp(req),
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
      });
    } catch (auditErr) {
      log.warn('KMS audit log write failed after project config delete failure', {
        tenantId: req.params.tenantId,
        projectId: req.params.projectId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    log.error('Failed to delete project KMS config', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KMS_CONFIG_ERROR', message: 'Failed to delete project config' },
    });
  }
});

router.delete(
  '/config/projects/:projectId/environments/:environment',
  requirePermission('kms:admin'),
  async (req, res) => {
    const startedAt = Date.now();
    try {
      const { tenantId, projectId, environment } = req.params;
      const { TenantKMSConfig } = await import('@agent-platform/database/models');
      const existingConfig = (await TenantKMSConfig.findOne({ tenantId }).lean()) as Record<
        string,
        any
      > | null;

      if (!existingConfig) {
        return res.status(404).json({
          success: false,
          error: { code: 'KMS_CONFIG_NOT_FOUND', message: 'KMS config not found' },
        });
      }

      const normalizedProjects = normalizeProjectOverrides(existingConfig.projects ?? []);
      const existingProject = normalizedProjects.find(
        (entry: any) => entry.projectId === projectId,
      );
      if (!existingProject) {
        return res.status(404).json({
          success: false,
          error: { code: 'KMS_OVERRIDE_NOT_FOUND', message: 'Project override not found' },
        });
      }

      const nextProjectEnvironments = removeEnvironmentOverride(
        existingProject.environments ?? [],
        environment,
      );
      if (nextProjectEnvironments.length === (existingProject.environments ?? []).length) {
        return res.status(404).json({
          success: false,
          error: { code: 'KMS_OVERRIDE_NOT_FOUND', message: 'Environment override not found' },
        });
      }

      const nextProjects =
        nextProjectEnvironments.length === 0 && !existingProject.defaultProvider
          ? removeProjectOverride(normalizedProjects, projectId)
          : upsertProjectOverride(normalizedProjects, {
              projectId,
              defaultProvider: existingProject.defaultProvider ?? null,
              environments: nextProjectEnvironments,
            });

      await persistTenantKMSConfigUpdate({
        tenantId,
        existingConfig,
        nextFields: {
          projects: nextProjects,
        },
      });

      const syncStatus = await syncTenantKMSConfigActivation(
        tenantId,
        'project environment config delete',
      );
      try {
        const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
        logKMSAuditEvent({
          tenantId,
          operation: 'environment_config_delete',
          keyId: existingProject.defaultProvider?.keyId || 'none',
          providerType: existingProject.defaultProvider?.providerType || 'system',
          projectId,
          environment,
          actorId: (req as any).tenantContext?.userId || 'unknown',
          actorType: 'user',
          actorIp: getActorIp(req),
          success: syncStatus.configActive,
          errorMessage: syncStatus.activationWarning,
          latencyMs: Date.now() - startedAt,
          metadata: {
            configActive: syncStatus.configActive,
          },
        });
      } catch (auditErr) {
        log.warn('KMS audit log write failed after environment config delete', {
          tenantId,
          projectId,
          environment,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }
      const data: Record<string, unknown> = {
        ...(await loadSanitizedTenantKMSConfig(tenantId)),
        configActive: syncStatus.configActive,
        projectId,
        environment,
      };
      if (syncStatus.activationWarning) data.activationWarning = syncStatus.activationWarning;
      if (syncStatus.propagationWarning) data.propagationWarning = syncStatus.propagationWarning;
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof KMSConfigConflictError) {
        return res.status(409).json({
          success: false,
          error: { code: 'KMS_CONFIG_CONFLICT', message: err.message },
        });
      }
      try {
        const { logKMSAuditEvent } = await import('../services/kms/kms-audit-logger.js');
        logKMSAuditEvent({
          tenantId: req.params.tenantId,
          operation: 'environment_config_delete',
          keyId: 'none',
          providerType: 'system',
          projectId: req.params.projectId,
          environment: req.params.environment,
          actorId: (req as any).tenantContext?.userId || 'unknown',
          actorType: 'user',
          actorIp: getActorIp(req),
          success: false,
          errorMessage: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - startedAt,
        });
      } catch (auditErr) {
        log.warn('KMS audit log write failed after environment config delete failure', {
          tenantId: req.params.tenantId,
          projectId: req.params.projectId,
          environment: req.params.environment,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }
      log.error('Failed to delete environment KMS config', {
        tenantId: req.params.tenantId,
        projectId: req.params.projectId,
        environment: req.params.environment,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'KMS_CONFIG_ERROR', message: 'Failed to delete environment config' },
      });
    }
  },
);

// =============================================================================
// GET /audit — Query KMS audit log
// =============================================================================

router.get('/audit', requirePermission('kms:admin'), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const {
      operation,
      success,
      startDate,
      endDate,
      limit: limitStr,
      offset: offsetStr,
    } = req.query;

    const limit = Math.max(parsePositiveInteger(limitStr, 25, 200), 1);
    const offset = parsePositiveInteger(offsetStr, 0, 100000);
    const normalizedStartDate = normalizeAuditBoundary(startDate, 'start');
    const normalizedEndDate = normalizeAuditBoundary(endDate, 'end');
    const successFilter = parseAuditSuccessFilter(success);

    if (startDate && !normalizedStartDate) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_START_DATE',
          message: 'Invalid startDate. Expected YYYY-MM-DD or ISO timestamp.',
        },
      });
    }

    if (endDate && !normalizedEndDate) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_END_DATE',
          message: 'Invalid endDate. Expected YYYY-MM-DD or ISO timestamp.',
        },
      });
    }

    const { conditions, queryParams } = buildKMSAuditWhereClause({
      tenantId,
      operation: typeof operation === 'string' && operation ? operation : undefined,
      success: successFilter,
      startDate: normalizedStartDate,
      endDate: normalizedEndDate,
    });
    const whereClause = conditions.join(' AND ');

    // Query ClickHouse audit log
    try {
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const client = getClickHouseClient();

      const [entriesResult, totalResult, summaryResult, operationsResult] = await Promise.all([
        client.query({
          query: `
            SELECT
              event_id,
              timestamp,
              operation,
              key_id,
              key_version,
              key_purpose,
              provider_type,
              project_id,
              environment,
              epoch,
              actor_id,
              actor_type,
              actor_ip,
              success,
              error_message,
              latency_ms,
              metadata
            FROM abl_platform.kms_audit_log
            WHERE ${whereClause}
            ORDER BY timestamp DESC
            LIMIT {limit:UInt32} OFFSET {offset:UInt32}
            SETTINGS max_execution_time = 10
          `,
          query_params: {
            ...queryParams,
            limit,
            offset,
          },
          format: 'JSONEachRow',
        }),
        client.query({
          query: `
            SELECT count() AS total
            FROM abl_platform.kms_audit_log
            WHERE ${whereClause}
            SETTINGS max_execution_time = 10
          `,
          query_params: queryParams,
          format: 'JSONEachRow',
        }),
        client.query({
          query: `
            SELECT
              count() AS total,
              countIf(success = 1) AS success_count,
              countIf(success = 0) AS failure_count,
              uniqExactIf(key_id, key_id != '') AS unique_keys,
              uniqExactIf(actor_id, actor_id != '') AS unique_actors,
              avgOrNull(latency_ms) AS avg_latency_ms,
              maxOrNull(timestamp) AS last_event_at
            FROM abl_platform.kms_audit_log
            WHERE ${whereClause}
            SETTINGS max_execution_time = 10
          `,
          query_params: queryParams,
          format: 'JSONEachRow',
        }),
        client.query({
          query: `
            SELECT operation, count() AS count
            FROM abl_platform.kms_audit_log
            WHERE ${buildKMSAuditWhereClause({
              tenantId,
              startDate: normalizedStartDate,
              endDate: normalizedEndDate,
            }).conditions.join(' AND ')}
            GROUP BY operation
            ORDER BY count DESC, operation ASC
            LIMIT 25
            SETTINGS max_execution_time = 10
          `,
          query_params: buildKMSAuditWhereClause({
            tenantId,
            startDate: normalizedStartDate,
            endDate: normalizedEndDate,
          }).queryParams,
          format: 'JSONEachRow',
        }),
      ]);

      const entries = (await entriesResult.json()) as Record<string, unknown>[];
      const totalRows = (await totalResult.json()) as Record<string, unknown>[];
      const summaryRows = (await summaryResult.json()) as Record<string, unknown>[];
      const operationRows = (await operationsResult.json()) as Record<string, unknown>[];

      const total = parseNumericResult(totalRows[0]?.total);
      const summary = normalizeKMSAuditSummary(summaryRows[0]);

      res.json({
        success: true,
        data: {
          entries,
          total,
          limit,
          offset,
          hasMore: offset + entries.length < total,
          summary,
          operations: operationRows.map((row) => ({
            operation: String(row.operation ?? ''),
            count: parseNumericResult(row.count),
          })),
        },
      });
    } catch (err) {
      // ClickHouse not available — return empty with warning
      log.warn('ClickHouse audit log query failed, returning empty', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.json({
        success: true,
        data: {
          entries: [],
          total: 0,
          limit,
          offset,
          hasMore: false,
          summary: {
            total: 0,
            successCount: 0,
            failureCount: 0,
            uniqueKeys: 0,
            uniqueActors: 0,
            avgLatencyMs: null,
            lastEventAt: null,
          },
          operations: [],
          message: 'Audit log not available (ClickHouse not configured)',
        },
      });
    }
  } catch (err) {
    log.error('Failed to query audit log', {
      tenantId: req.params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KMS_QUERY_ERROR', message: 'Failed to query audit log' },
    });
  }
});

// =============================================================================
// GET /health — KMS health for tenant
// =============================================================================

router.get('/health', requirePermission('kms:admin'), async (req, res) => {
  try {
    const { tenantId } = req.params;

    // Use shared resolver (L1 cache) if available, else create a fresh one
    const { getGlobalKMSResolver, KMSResolver } = await import('@agent-platform/database/kms');
    let resolver = getGlobalKMSResolver();
    if (!resolver) {
      resolver = new KMSResolver();
    }

    // Resolve the default config for this tenant
    const config = await resolver.resolve(tenantId);

    // Check KMS provider health
    const {
      getKMSProviderPool,
      isKMSProviderPoolAvailable,
      verifyProviderReadiness,
      computeFingerprint,
    } = await import('@agent-platform/database/kms');

    if (!isKMSProviderPoolAvailable()) {
      return res.json({
        success: true,
        data: {
          tenantId,
          healthy: false,
          provider: config.provider.providerType,
          message: 'KMS provider pool not available',
        },
      });
    }

    const pool = getKMSProviderPool();
    const kms = await pool.getProvider(config.provider);
    const readiness = await verifyProviderReadiness(kms, config.keyId);

    // Count active DEKs
    const { DEKEntry, TenantKMSConfig } = await import('@agent-platform/database/models');
    const activeDEKs = await DEKEntry.countDocuments({ tenantId, status: 'active' });
    const decryptOnlyDEKs = await DEKEntry.countDocuments({ tenantId, status: 'decrypt_only' });
    const migrationEntries = (await DEKEntry.find({
      tenantId,
      status: { $in: ['active', 'decrypt_only'] },
    })
      .select('wrappingProvider')
      .lean()) as Array<{ wrappingProvider?: Record<string, unknown> | null }>;
    const targetFingerprint = computeFingerprint(config.provider);
    const tenantKMSConfig = await TenantKMSConfig.findOne({ tenantId }).lean();
    const migration = buildMigrationHealth({
      entries: migrationEntries.map((entry) => ({
        wrappingProvider: entry.wrappingProvider
          ? {
              ...(entry.wrappingProvider as Record<string, unknown>),
              __fingerprint: computeFingerprint(entry.wrappingProvider as any),
            }
          : null,
      })),
      targetFingerprint,
      targetProviderType: config.provider.providerType,
      cryptoVerified: readiness.cryptoVerified,
      authConfigDependencyCount: countEncryptedAuthConfigDependencies(tenantKMSConfig),
    });

    res.json({
      success: true,
      data: {
        tenantId,
        healthy: readiness.healthy,
        provider: config.provider.providerType,
        failurePolicy: config.failurePolicy,
        deks: {
          active: activeDEKs,
          decryptOnly: decryptOnlyDEKs,
        },
        providerHealth: readiness,
        migration,
      },
    });
  } catch (err) {
    log.error('Failed to check KMS health', {
      tenantId: req.params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KMS_HEALTH_ERROR', message: 'Failed to check KMS health' },
    });
  }
});

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Redact sensitive fields from KMS config before returning to API.
 */
function sanitizeConfig(config: any): any {
  if (!config) return config;

  return {
    tenantId: config.tenantId,
    configured: true,
    defaultProvider: sanitizeProviderRef(config.defaultProvider),
    environments: Array.isArray(config.environments)
      ? config.environments.map((entry: any) => sanitizeEnvironmentOverride(entry))
      : [],
    projects: Array.isArray(config.projects)
      ? config.projects.map((entry: any) => sanitizeProjectOverride(entry))
      : [],
    dekRetentionDays: config.dekRetentionDays ?? null,
    dekEpochIntervalHours: config.dekEpochIntervalHours ?? 24,
    dekMaxUsageCount: config.dekMaxUsageCount ?? 2 ** 30,
    kekRotationPeriodDays: config.kekRotationPeriodDays ?? 365,
    reencryption: config.reencryption ?? {
      enabled: true,
      concurrency: 1,
      batchSize: 50,
      maxRetries: 3,
    },
    byokEnabled: config.byokEnabled ?? false,
    byopEnabled: config.byopEnabled ?? false,
    complianceLevel: config.complianceLevel ?? 'standard',
    failurePolicy: config.failurePolicy ?? 'fail-closed',
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    id: config._id,
  };
}

function sanitizeProviderRef(provider: any): any {
  if (!provider) {
    return null;
  }

  return {
    providerType: provider.providerType,
    keyId: provider.keyId,
    region: provider.region ?? null,
    vaultUrl: provider.vaultUrl ?? null,
    externalEndpoint: provider.externalEndpoint ?? null,
    authMethod: provider.authMethod ?? null,
    authConfigEncrypted: provider.authConfigEncrypted ? '[REDACTED]' : undefined,
  };
}

function buildRotationFilter(
  tenantId: string,
  projectId?: string,
  environment?: string,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    tenantId,
    status: 'active',
  };

  if (projectId) {
    filter.projectId = projectId;
  }
  if (environment) {
    filter.environment = environment;
  }

  return filter;
}

function sanitizeEnvironmentOverride(entry: any): any {
  return {
    environment: entry.environment,
    provider: sanitizeProviderRef(entry.provider),
  };
}

function sanitizeProjectOverride(entry: any): any {
  return {
    projectId: entry.projectId,
    defaultProvider: sanitizeProviderRef(entry.defaultProvider),
    environments: Array.isArray(entry.environments)
      ? entry.environments.map((env: any) => sanitizeEnvironmentOverride(env))
      : [],
  };
}

function sanitizeDEKEntry(entry: any): any {
  return {
    _id: entry._id,
    dekId: entry.dekId,
    tenantId: entry.tenantId,
    projectId: entry.projectId,
    environment: entry.environment,
    epoch: entry.epoch,
    kekKeyId: entry.kekKeyId,
    kekKeyVersion: entry.kekKeyVersion,
    wrappingProvider:
      sanitizeProviderRef(entry.wrappingProvider) ??
      ({
        providerType: 'local',
        keyId: entry.kekKeyId,
        region: null,
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: null,
      } as const),
    wrappingSourceConfigVersion: entry.wrappingSourceConfigVersion ?? null,
    status: entry.status,
    usageCount: entry.usageCount ?? 0,
    maxUsageCount: entry.maxUsageCount ?? 2 ** 30,
    expiresAt: entry.expiresAt ?? null,
    retiredAt: entry.retiredAt ?? null,
    destroyedAt: entry.destroyedAt ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    id: entry._id,
  };
}

function buildMigrationHealth(params: {
  entries: Array<{ wrappingProvider?: { __fingerprint?: string; providerType?: string } | null }>;
  targetFingerprint: string;
  targetProviderType: string;
  cryptoVerified: boolean;
  authConfigDependencyCount: number;
}): KMSMigrationHealth {
  const implicitLocalMetadataCount = params.entries.filter(
    (entry) => !entry.wrappingProvider,
  ).length;
  const legacyLocalDekCount = params.entries.filter(
    (entry) => !entry.wrappingProvider || entry.wrappingProvider.providerType === 'local',
  ).length;
  const driftedDekCount = params.entries.filter((entry) => {
    if (!entry.wrappingProvider) {
      return true;
    }
    return entry.wrappingProvider.__fingerprint !== params.targetFingerprint;
  }).length;

  const migrationActive = params.targetProviderType !== 'local';
  const localMasterKeyStillRequired =
    legacyLocalDekCount > 0 ||
    implicitLocalMetadataCount > 0 ||
    params.authConfigDependencyCount > 0;
  const dekMigrationComplete =
    migrationActive &&
    params.cryptoVerified &&
    legacyLocalDekCount === 0 &&
    implicitLocalMetadataCount === 0 &&
    driftedDekCount === 0;

  const warnings: string[] = [];
  if (migrationActive && !params.cryptoVerified) {
    warnings.push('Target provider failed the crypto readiness probe.');
  }
  if (legacyLocalDekCount > 0) {
    warnings.push(
      `${legacyLocalDekCount} DEK entries still depend on local wrapping or legacy local fallback.`,
    );
  }
  if (implicitLocalMetadataCount > 0) {
    warnings.push(
      `${implicitLocalMetadataCount} DEK entries are missing wrappingProvider metadata and still rely on local fallback semantics.`,
    );
  }
  if (params.authConfigDependencyCount > 0) {
    warnings.push(
      `${params.authConfigDependencyCount} tenant KMS provider configuration entries still depend on platform-local auth credential decryption.`,
    );
  }
  if (migrationActive && driftedDekCount > 0) {
    warnings.push(
      `${driftedDekCount} active or decrypt-only DEKs do not match the current target provider fingerprint.`,
    );
  }

  return {
    migrationActive,
    cryptoVerified: params.cryptoVerified,
    legacyLocalDekCount,
    implicitLocalMetadataCount,
    driftedDekCount,
    authConfigDependencyCount: params.authConfigDependencyCount,
    localMasterKeyStillRequired,
    dekMigrationComplete,
    warnings,
  };
}

function countEncryptedAuthConfigDependencies(config: any): number {
  if (!config) {
    return 0;
  }

  const providers: Array<Record<string, unknown> | null | undefined> = [config.defaultProvider];

  if (Array.isArray(config.environments)) {
    for (const environment of config.environments) {
      providers.push(environment?.provider);
    }
  }

  if (Array.isArray(config.projects)) {
    for (const project of config.projects) {
      providers.push(project?.defaultProvider);
      if (Array.isArray(project?.environments)) {
        for (const environment of project.environments) {
          providers.push(environment?.provider);
        }
      }
    }
  }

  return providers.filter(
    (provider) =>
      provider != null &&
      typeof provider.authConfigEncrypted === 'string' &&
      provider.authConfigEncrypted.length > 0,
  ).length;
}

function getActorIp(req: {
  ip?: string;
  headers?: {
    get?: (name: string) => string | null;
    [key: string]: unknown;
  };
}): string {
  const forwarded =
    typeof req.headers?.get === 'function'
      ? req.headers.get('x-forwarded-for')
      : req.headers?.['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (forwardedValue) {
    return forwardedValue.split(',')[0]?.trim() || req.ip || '';
  }
  return req.ip || '';
}

async function encryptProviderForStorage(
  provider: Record<string, unknown> | null,
  existingProvider: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  if (!provider) {
    return null;
  }

  const authConfig = provider.authConfig as Record<string, string> | null | undefined;
  let authConfigEncrypted =
    (existingProvider?.authConfigEncrypted as string | null | undefined) ?? null;

  if (authConfig) {
    const { getKMSProviderPool, isKMSProviderPoolAvailable, encryptAuthConfig } =
      await import('@agent-platform/database/kms');
    if (!isKMSProviderPoolAvailable()) {
      throw new Error('KMS provider pool not initialized — retry after server startup completes');
    }
    const pool = getKMSProviderPool();
    const localProvider = pool.getLocalProvider();
    authConfigEncrypted = await encryptAuthConfig(authConfig, localProvider, 'platform-default');
  }

  return {
    providerType: provider.providerType,
    keyId: provider.keyId,
    region: provider.region ?? null,
    vaultUrl: provider.vaultUrl ?? null,
    externalEndpoint: provider.externalEndpoint ?? null,
    authMethod: provider.authMethod ?? null,
    authConfigEncrypted,
  };
}

async function loadSanitizedTenantKMSConfig(tenantId: string): Promise<Record<string, unknown>> {
  const { TenantKMSConfig } = await import('@agent-platform/database/models');
  const config = await TenantKMSConfig.findOne({ tenantId }).lean();

  if (!config) {
    const platformDefault = await getPlatformDefaultSummary();
    return {
      tenantId,
      configured: false,
      usingDefault: true,
      message: platformDefault.message,
    };
  }

  return {
    tenantId,
    configured: true,
    ...sanitizeConfig(config),
  };
}

function normalizeProjectOverrides(projects: any[]): any[] {
  const merged = new Map<string, any>();

  for (const project of projects) {
    const existing = merged.get(project.projectId);
    if (!existing) {
      merged.set(project.projectId, {
        projectId: project.projectId,
        defaultProvider: project.defaultProvider ?? null,
        environments: upsertEnvironmentOverrides([], project.environments ?? []),
      });
      continue;
    }

    merged.set(project.projectId, {
      projectId: project.projectId,
      defaultProvider: project.defaultProvider ?? existing.defaultProvider ?? null,
      environments: upsertEnvironmentOverrides(
        existing.environments ?? [],
        project.environments ?? [],
      ),
    });
  }

  return Array.from(merged.values());
}

function upsertProjectOverride(projects: any[], nextProject: any): any[] {
  const normalizedProjects = normalizeProjectOverrides(projects);
  const index = normalizedProjects.findIndex(
    (entry: any) => entry.projectId === nextProject.projectId,
  );
  if (index >= 0) {
    normalizedProjects[index] = nextProject;
  } else {
    normalizedProjects.push(nextProject);
  }
  return normalizedProjects;
}

function upsertEnvironmentOverrides(existing: any[], incoming: any[]): any[] {
  let merged = [...existing];
  for (const entry of incoming) {
    merged = upsertEnvironmentOverride(merged, entry);
  }
  return merged;
}

function upsertEnvironmentOverride(environments: any[], nextEnvironment: any): any[] {
  const merged = [...environments];
  const index = merged.findIndex((entry: any) => entry.environment === nextEnvironment.environment);
  if (index >= 0) {
    merged[index] = nextEnvironment;
  } else {
    merged.push(nextEnvironment);
  }
  return merged;
}

async function syncTenantKMSConfigActivation(
  tenantId: string,
  operation: string,
): Promise<{
  configActive: boolean;
  activationWarning?: string;
  propagationWarning?: string;
}> {
  let configActive = true;
  let activationWarning: string | undefined;

  try {
    const { KMSMaterializer } = await import('../services/kms/kms-materializer.js');
    const materializer = new KMSMaterializer();
    await materializer.materialize(tenantId);
  } catch (err) {
    log.error(`Materialization after ${operation} failed`, {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    configActive = false;
    activationWarning = 'KMS config saved but materialization failed — config is not active yet';
  }

  if (!configActive) {
    return { configActive, activationWarning };
  }

  let cacheInvalidationComplete = true;
  try {
    const { getGlobalKMSResolver } = await import('@agent-platform/database/kms');
    const resolver = getGlobalKMSResolver();
    if (resolver) {
      resolver.evictTenant(tenantId);
      await resolver.publishInvalidation(tenantId);
    }
  } catch (err) {
    log.warn('KMS config cache invalidation failed', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    cacheInvalidationComplete = false;
  }

  let redisAvailable = true;
  try {
    const { isRedisAvailable: checkRedis } = await import('../services/redis/redis-client.js');
    redisAvailable = checkRedis();
  } catch (err) {
    log.warn('Redis availability check failed', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    redisAvailable = false;
  }

  if (!redisAvailable || !cacheInvalidationComplete) {
    log.warn('Redis unavailable during KMS config update — cross-pod propagation delayed', {
      tenantId,
    });
    return {
      configActive,
      propagationWarning:
        'Redis unavailable — KMS config changes may take up to 60s to propagate across pods',
    };
  }

  return { configActive };
}

export default router;
