/**
 * Guardrail Provider Config CRUD Route
 *
 * Manages tenant-level guardrail provider configurations:
 * adapter type, endpoint, model, categories, circuit breaker, retry, health.
 *
 * Mount: /api/tenants/:tenantId/guardrail-providers
 */

import { Router, type Router as RouterType } from 'express';
import { AuthProfile, TenantGuardrailProviderConfig } from '@agent-platform/database/models';
import { IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES } from '@agent-platform/database/constants/guardrail-adapters';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { writeAuditLog } from '../repos/auth-repo.js';
import { requireFeature } from '../middleware/feature-gate.js';
import {
  createGuardrailProviderFromConfig,
  invalidateGuardrailEvalCache,
  invalidateTenantProviderCache,
} from '../services/guardrails/pipeline-factory.js';

const log = createLogger('guardrail-providers-route');

const router: RouterType = Router({ mergeParams: true });

// All routes require authentication + rate limiting
router.use(authMiddleware);
router.use(tenantRateLimit('request'));
// Feature gate: Guardrails requires TEAM tier or above
router.use(requireFeature('guardrails'));

// =============================================================================
// HELPERS
// =============================================================================

function getTenantId(req: any): string | null {
  const contextTenantId = req.tenantContext?.tenantId;
  if (!contextTenantId) return null;

  const paramTenantId = req.params.tenantId;
  if (paramTenantId && paramTenantId !== contextTenantId) {
    return null;
  }

  return contextTenantId;
}

function hasOwnKey(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function isUnitIntervalNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function rejectRawApiKey(body: Record<string, unknown>, res: any): boolean {
  if (!hasOwnKey(body, 'apiKey')) {
    return false;
  }

  res.status(400).json({
    success: false,
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Raw apiKey is not supported for guardrail providers; use authProfileId instead',
    },
  });
  return true;
}

async function validateTenantProviderAuthProfile(
  body: Record<string, unknown>,
  tenantId: string,
): Promise<{ code: string; message: string } | null> {
  if (!hasOwnKey(body, 'authProfileId')) {
    return null;
  }

  const rawAuthProfileId = body.authProfileId;
  if (rawAuthProfileId === undefined || rawAuthProfileId === null || rawAuthProfileId === '') {
    return null;
  }

  if (typeof rawAuthProfileId !== 'string' || rawAuthProfileId.trim().length === 0) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'authProfileId must be a non-empty string when provided',
    };
  }

  const authProfileId = rawAuthProfileId.trim();
  body.authProfileId = authProfileId;

  const now = new Date();
  const profile = await AuthProfile.findOne({
    _id: authProfileId,
    tenantId,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .select({ _id: 1, scope: 1, projectId: 1, visibility: 1 })
    .lean();

  if (!profile) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'authProfileId must reference an active auth profile in this tenant',
    };
  }

  if (profile.scope !== 'tenant' || profile.projectId || profile.visibility !== 'shared') {
    return {
      code: 'VALIDATION_ERROR',
      message:
        'tenant guardrail providers may only reference active tenant-scoped shared auth profiles',
    };
  }

  return null;
}

function validateExecutableProviderConfig(
  body: Record<string, unknown>,
): { code: string; message: string } | null {
  if (body.adapterType !== 'openai_moderation' || body.isActive === false) {
    return null;
  }

  const authProfileId = body.authProfileId;
  if (typeof authProfileId === 'string' && authProfileId.trim().length > 0) {
    return null;
  }

  return {
    code: 'VALIDATION_ERROR',
    message: 'active openai_moderation providers require an authProfileId',
  };
}

function validateProviderNumericControls(
  body: Record<string, unknown>,
): { code: string; message: string } | null {
  if (hasOwnKey(body, 'defaultThreshold') && !isUnitIntervalNumber(body.defaultThreshold)) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'defaultThreshold must be a number between 0 and 1',
    };
  }

  if (hasOwnKey(body, 'costPerEvalUsd') && !isNonNegativeFiniteNumber(body.costPerEvalUsd)) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'costPerEvalUsd must be a non-negative number',
    };
  }

  if (hasOwnKey(body, 'circuitBreaker')) {
    if (!body.circuitBreaker || typeof body.circuitBreaker !== 'object') {
      return {
        code: 'VALIDATION_ERROR',
        message: 'circuitBreaker must be an object when provided',
      };
    }
    const circuitBreaker = body.circuitBreaker as Record<string, unknown>;
    if (
      hasOwnKey(circuitBreaker, 'failureThreshold') &&
      !isPositiveInteger(circuitBreaker.failureThreshold)
    ) {
      return {
        code: 'VALIDATION_ERROR',
        message: 'circuitBreaker.failureThreshold must be a positive integer',
      };
    }
    if (
      hasOwnKey(circuitBreaker, 'resetTimeoutMs') &&
      !isPositiveInteger(circuitBreaker.resetTimeoutMs)
    ) {
      return {
        code: 'VALIDATION_ERROR',
        message: 'circuitBreaker.resetTimeoutMs must be a positive integer',
      };
    }
  }

  if (hasOwnKey(body, 'retry')) {
    if (!body.retry || typeof body.retry !== 'object') {
      return {
        code: 'VALIDATION_ERROR',
        message: 'retry must be an object when provided',
      };
    }
    const retry = body.retry as Record<string, unknown>;
    if (hasOwnKey(retry, 'maxRetries') && !isNonNegativeInteger(retry.maxRetries)) {
      return {
        code: 'VALIDATION_ERROR',
        message: 'retry.maxRetries must be a non-negative integer',
      };
    }
    if (hasOwnKey(retry, 'backoffBaseMs') && !isNonNegativeInteger(retry.backoffBaseMs)) {
      return {
        code: 'VALIDATION_ERROR',
        message: 'retry.backoffBaseMs must be a non-negative integer',
      };
    }
  }

  return null;
}

function validateAdapterType(adapterType: unknown): { code: string; message: string } | null {
  if (adapterType === undefined || adapterType === null) {
    return null;
  }

  if (typeof adapterType !== 'string') {
    return {
      code: 'VALIDATION_ERROR',
      message: 'adapterType must be a string when provided',
    };
  }

  if (!IMPLEMENTED_ADAPTER_TYPES.has(adapterType)) {
    return {
      code: 'ADAPTER_NOT_IMPLEMENTED',
      message: `Provider type "${adapterType}" is not yet available. Supported: ${[...IMPLEMENTED_ADAPTER_TYPES].join(', ')}`,
    };
  }

  return null;
}

/** Adapter types that have a working runtime implementation */
const IMPLEMENTED_ADAPTER_TYPES: ReadonlySet<string> = new Set(IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES);

/** Fields that must be present on create */
const REQUIRED_CREATE_FIELDS = [
  'name',
  'displayName',
  'adapterType',
  'endpoint',
  'model',
  'hosting',
  'defaultCategory',
  'defaultThreshold',
  'circuitBreaker',
  'retry',
] as const;

/** Fields that cannot be set/overridden by the client */
const PROTECTED_FIELDS = new Set(['tenantId', '_id', '_v', 'createdAt', 'updatedAt']);

/**
 * Strip protected fields from a request body before passing to $set.
 */
function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!PROTECTED_FIELDS.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function normalizeProviderBody(body: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...body };

  if (normalized.circuitBreaker && typeof normalized.circuitBreaker === 'object') {
    const circuitBreaker = { ...(normalized.circuitBreaker as Record<string, unknown>) };
    if ('maxFailures' in circuitBreaker && !('failureThreshold' in circuitBreaker)) {
      circuitBreaker.failureThreshold = circuitBreaker.maxFailures;
    }
    if ('resetTimeout' in circuitBreaker && !('resetTimeoutMs' in circuitBreaker)) {
      circuitBreaker.resetTimeoutMs = circuitBreaker.resetTimeout;
    }
    delete circuitBreaker.maxFailures;
    delete circuitBreaker.resetTimeout;
    normalized.circuitBreaker = circuitBreaker;
  }

  if (normalized.retry && typeof normalized.retry === 'object') {
    const retry = { ...(normalized.retry as Record<string, unknown>) };
    if ('backoff' in retry && !('backoffBaseMs' in retry)) {
      retry.backoffBaseMs = typeof retry.backoff === 'number' ? retry.backoff : 1000;
    }
    delete retry.backoff;
    normalized.retry = retry;
  }

  return normalized;
}

// =============================================================================
// LIST — GET /
// =============================================================================

router.get('/', requirePermission('credential:read'), async (req: any, res) => {
  const requestId = getCurrentRequestId();
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'TENANT_ACCESS_DENIED', message: 'Tenant access denied' },
      });
      return;
    }

    const providers = await TenantGuardrailProviderConfig.find({ tenantId })
      .sort({ name: 1 })
      .lean();

    res.json({ success: true, data: providers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to list guardrail providers', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list guardrail providers' },
    });
  }
});

// =============================================================================
// CREATE — POST /
// =============================================================================

router.post('/', requirePermission('credential:write'), async (req: any, res) => {
  const requestId = getCurrentRequestId();
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'TENANT_ACCESS_DENIED', message: 'Tenant access denied' },
      });
      return;
    }

    if (rejectRawApiKey(req.body ?? {}, res)) {
      return;
    }

    const normalized = normalizeProviderBody(req.body ?? {});

    const authProfileValidation = await validateTenantProviderAuthProfile(normalized, tenantId);
    if (authProfileValidation) {
      res.status(400).json({
        success: false,
        error: authProfileValidation,
      });
      return;
    }

    const numericValidation = validateProviderNumericControls(normalized);
    if (numericValidation) {
      res.status(400).json({
        success: false,
        error: numericValidation,
      });
      return;
    }

    const executabilityValidation = validateExecutableProviderConfig(normalized);
    if (executabilityValidation) {
      res.status(400).json({
        success: false,
        error: executabilityValidation,
      });
      return;
    }

    // Validate required fields
    const missing = REQUIRED_CREATE_FIELDS.filter(
      (f) => normalized[f] === undefined || normalized[f] === null,
    );
    if (missing.length > 0) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `Missing required fields: ${missing.join(', ')}`,
        },
      });
      return;
    }

    const adapterTypeValidation = validateAdapterType(normalized.adapterType);
    if (adapterTypeValidation) {
      res.status(400).json({
        success: false,
        error: adapterTypeValidation,
      });
      return;
    }

    const sanitized = sanitizeBody(normalized);
    const config = await TenantGuardrailProviderConfig.create({
      ...sanitized,
      tenantId,
    });

    // Invalidate provider cache so next evaluation picks up the new provider
    invalidateTenantProviderCache(tenantId);
    invalidateGuardrailEvalCache(tenantId);

    const userId = req.tenantContext?.userId;
    log.info('Guardrail provider created', { tenantId, name: config.name, requestId });
    writeAuditLog({
      action: 'guardrail-provider:create',
      tenantId,
      userId,
      metadata: { providerId: config._id, name: config.name, requestId },
    });

    res.status(201).json({ success: true, data: config });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    // Handle duplicate key error (unique index on tenantId + name)
    if (err?.code === 11000) {
      res.status(409).json({
        success: false,
        error: { code: 'DUPLICATE', message: 'A guardrail provider with this name already exists' },
      });
      return;
    }
    log.error('Failed to create guardrail provider', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create guardrail provider' },
    });
  }
});

// =============================================================================
// GET BY ID — GET /:id
// =============================================================================

router.get('/:id', requirePermission('credential:read'), async (req: any, res) => {
  const requestId = getCurrentRequestId();
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'TENANT_ACCESS_DENIED', message: 'Tenant access denied' },
      });
      return;
    }

    const provider = await TenantGuardrailProviderConfig.findOne({
      _id: req.params.id,
      tenantId,
    }).lean();

    if (!provider) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Guardrail provider not found' },
      });
      return;
    }

    res.json({ success: true, data: provider });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to get guardrail provider', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get guardrail provider' },
    });
  }
});

// =============================================================================
// UPDATE — PUT /:id
// =============================================================================

router.put('/:id', requirePermission('credential:write'), async (req: any, res) => {
  const requestId = getCurrentRequestId();
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'TENANT_ACCESS_DENIED', message: 'Tenant access denied' },
      });
      return;
    }

    if (rejectRawApiKey(req.body ?? {}, res)) {
      return;
    }

    const normalized = normalizeProviderBody(req.body ?? {});
    const sanitized = sanitizeBody(normalized);

    const authProfileValidation = await validateTenantProviderAuthProfile(sanitized, tenantId);
    if (authProfileValidation) {
      res.status(400).json({
        success: false,
        error: authProfileValidation,
      });
      return;
    }

    const numericValidation = validateProviderNumericControls(sanitized);
    if (numericValidation) {
      res.status(400).json({
        success: false,
        error: numericValidation,
      });
      return;
    }

    const adapterTypeValidation = validateAdapterType(sanitized.adapterType);
    if (adapterTypeValidation) {
      res.status(400).json({
        success: false,
        error: adapterTypeValidation,
      });
      return;
    }

    const existing = await TenantGuardrailProviderConfig.findOne({
      _id: req.params.id,
      tenantId,
    }).lean();

    if (!existing) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Guardrail provider not found' },
      });
      return;
    }

    const effectiveConfig = { ...existing, ...sanitized };
    const executabilityValidation = validateExecutableProviderConfig(effectiveConfig);
    if (executabilityValidation) {
      res.status(400).json({
        success: false,
        error: executabilityValidation,
      });
      return;
    }

    const updated = await TenantGuardrailProviderConfig.findOneAndUpdate(
      { _id: req.params.id, tenantId },
      { $set: sanitized },
      { new: true, runValidators: true },
    ).lean();

    // Invalidate provider cache so next evaluation reloads from DB
    invalidateTenantProviderCache(tenantId);
    invalidateGuardrailEvalCache(tenantId);

    const userId = req.tenantContext?.userId;
    log.info('Guardrail provider updated', { tenantId, providerId: req.params.id, requestId });
    writeAuditLog({
      action: 'guardrail-provider:update',
      tenantId,
      userId,
      metadata: { providerId: req.params.id, fields: Object.keys(sanitized), requestId },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to update guardrail provider', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update guardrail provider' },
    });
  }
});

// =============================================================================
// DELETE — DELETE /:id
// =============================================================================

router.delete('/:id', requirePermission('credential:write'), async (req: any, res) => {
  const requestId = getCurrentRequestId();
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'TENANT_ACCESS_DENIED', message: 'Tenant access denied' },
      });
      return;
    }

    const deleted = await TenantGuardrailProviderConfig.findOneAndDelete({
      _id: req.params.id,
      tenantId,
    });

    if (!deleted) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Guardrail provider not found' },
      });
      return;
    }

    // Invalidate provider cache so next evaluation reloads from DB
    invalidateTenantProviderCache(tenantId);
    invalidateGuardrailEvalCache(tenantId);

    const userId = req.tenantContext?.userId;
    log.info('Guardrail provider deleted', { tenantId, providerId: req.params.id, requestId });
    writeAuditLog({
      action: 'guardrail-provider:delete',
      tenantId,
      userId,
      metadata: { providerId: req.params.id, name: (deleted as any).name, requestId },
    });

    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to delete guardrail provider', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete guardrail provider' },
    });
  }
});

// =============================================================================
// TEST — POST /:id/test
// =============================================================================

router.post('/:id/test', requirePermission('credential:read'), async (req: any, res) => {
  const requestId = getCurrentRequestId();
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'TENANT_ACCESS_DENIED', message: 'Tenant access denied' },
      });
      return;
    }

    const { text } = req.body || {};
    if (!text || typeof text !== 'string') {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request body must include a "text" field' },
      });
      return;
    }

    const provider = await TenantGuardrailProviderConfig.findOne({
      _id: req.params.id,
      tenantId,
    }).lean();

    if (!provider) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Guardrail provider not found' },
      });
      return;
    }

    const runtimeProvider = await createGuardrailProviderFromConfig(
      provider as Record<string, unknown>,
      tenantId,
    );
    if (!runtimeProvider) {
      res.status(400).json({
        success: false,
        error: {
          code: 'PROVIDER_NOT_TESTABLE',
          message: 'Guardrail provider is not testable with the current configuration',
        },
      });
      return;
    }

    const result = await runtimeProvider.evaluate({
      content: text,
      category:
        typeof provider.defaultCategory === 'string' && provider.defaultCategory.trim().length > 0
          ? provider.defaultCategory.trim()
          : 'general',
    });
    const raw =
      result.raw && typeof result.raw === 'object' ? (result.raw as Record<string, unknown>) : {};
    const testStatus =
      raw.failedOpen === true || raw.failedClosed === true ? 'unhealthy' : 'healthy';

    res.json({
      success: true,
      data: {
        providerId: provider._id,
        providerName: provider.name,
        adapterType: provider.adapterType,
        endpoint: provider.endpoint,
        status: testStatus,
        category: result.category,
        score: result.score,
        severity: result.severity,
        label: result.label,
        explanation: result.explanation,
        latencyMs: result.latencyMs,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to test guardrail provider', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to test guardrail provider' },
    });
  }
});

export default router;
