/**
 * Guardrail Policy CRUD Route
 *
 * Manages tenant-, project-, and agent-scoped guardrail policies: rules,
 * provider overrides, constitution principles, streaming, caching, and budget
 * controls.
 *
 * Mounts:
 *   - /api/guardrail-policies
 *   - /api/projects/:projectId/guardrail-policies
 */

import { z } from 'zod';
import { Router, type Router as RouterType } from 'express';
import { GuardrailPolicy, Project } from '@agent-platform/database/models';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { validateRule, type GuardrailRuleInput } from '@agent-platform/shared';
import { writeAuditLog } from '../repos/auth-repo.js';
import {
  getRouteScopeContext,
  buildScopedPolicyFilter,
  requireRouteScopePermission,
  type RouteScopeContext,
} from './guardrail-helpers.js';
import { requireFeature } from '../middleware/feature-gate.js';
import { encryptForTenantAuto } from '@agent-platform/shared/encryption';
import {
  invalidateTenantProviderCache,
  invalidateGuardrailEvalCache,
} from '../services/guardrails/pipeline-factory.js';
import { bumpGuardrailPolicyEpoch } from '../services/guardrails/policy-epoch.js';
import { GuardrailCostTracker } from '../services/guardrails/cost-tracker.js';
import { getRedisClient } from '../services/redis/redis-client.js';

const log = createLogger('guardrail-policies-route');

const router: RouterType = Router({ mergeParams: true });
let sharedCostTracker: GuardrailCostTracker | undefined;

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
  return contextTenantId;
}

function getSharedCostTracker(): GuardrailCostTracker {
  if (sharedCostTracker === undefined) {
    sharedCostTracker = new GuardrailCostTracker(getRedisClient());
  }
  return sharedCostTracker;
}

type GuardrailPolicyScope = {
  type: 'tenant' | 'project' | 'agent';
  projectId?: string;
  agentDefId?: string;
};

type NormalizedSettings = {
  failMode: 'open' | 'closed';
  timeouts: {
    local: number;
    model: number;
    llm: number;
  };
  streaming: {
    enabled: boolean;
    defaultInterval: 'token' | 'sentence' | 'chunk_size';
    chunkSize: number;
    maxLatencyMs: number;
    earlyTermination: boolean;
  };
  webhookUrl?: string;
  webhookSecret?: string;
  encryptedWebhookSecret?: string;
};

type NormalizedCaching = {
  enabled: boolean;
  exactMatch: boolean;
  semanticMatch: boolean;
  semanticThreshold: number;
  defaultTtlSeconds: number;
};

type NormalizedBudget = {
  monthlyLimitUsd: number;
  currentSpendUsd: number;
  overspendAction: 'downgrade' | 'disable_model_checks' | 'alert_only';
};

const DEFAULT_POLICY_SETTINGS: NormalizedSettings = {
  failMode: 'open',
  timeouts: {
    local: 100,
    model: 5000,
    llm: 15000,
  },
  streaming: {
    enabled: false,
    defaultInterval: 'sentence',
    chunkSize: 256,
    maxLatencyMs: 500,
    earlyTermination: true,
  },
};

const DEFAULT_POLICY_CACHING: NormalizedCaching = {
  enabled: false,
  exactMatch: true,
  semanticMatch: false,
  semanticThreshold: 0.95,
  defaultTtlSeconds: 3600,
};

const DEFAULT_POLICY_BUDGET: NormalizedBudget = {
  monthlyLimitUsd: 100,
  currentSpendUsd: 0,
  overspendAction: 'alert_only',
};

function hasOwnKey(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isUnitIntervalNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeStoredSettings(settings: unknown): NormalizedSettings {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return {
      ...DEFAULT_POLICY_SETTINGS,
      timeouts: { ...DEFAULT_POLICY_SETTINGS.timeouts },
      streaming: { ...DEFAULT_POLICY_SETTINGS.streaming },
    };
  }

  const raw = settings as Record<string, unknown>;
  const timeouts =
    raw.timeouts && typeof raw.timeouts === 'object' && !Array.isArray(raw.timeouts)
      ? (raw.timeouts as Record<string, unknown>)
      : {};
  const streaming =
    raw.streaming && typeof raw.streaming === 'object' && !Array.isArray(raw.streaming)
      ? (raw.streaming as Record<string, unknown>)
      : {};

  return {
    failMode: raw.failMode === 'open' ? 'open' : raw.failMode === 'closed' ? 'closed' : 'open',
    timeouts: {
      local: isPositiveFiniteNumber(timeouts.local)
        ? timeouts.local
        : DEFAULT_POLICY_SETTINGS.timeouts.local,
      model: isPositiveFiniteNumber(timeouts.model)
        ? timeouts.model
        : DEFAULT_POLICY_SETTINGS.timeouts.model,
      llm: isPositiveFiniteNumber(timeouts.llm)
        ? timeouts.llm
        : DEFAULT_POLICY_SETTINGS.timeouts.llm,
    },
    streaming: {
      enabled:
        typeof streaming.enabled === 'boolean'
          ? streaming.enabled
          : DEFAULT_POLICY_SETTINGS.streaming.enabled,
      defaultInterval:
        streaming.defaultInterval === 'token' ||
        streaming.defaultInterval === 'sentence' ||
        streaming.defaultInterval === 'chunk_size'
          ? streaming.defaultInterval
          : DEFAULT_POLICY_SETTINGS.streaming.defaultInterval,
      chunkSize: isPositiveFiniteNumber(streaming.chunkSize)
        ? streaming.chunkSize
        : DEFAULT_POLICY_SETTINGS.streaming.chunkSize,
      maxLatencyMs: isPositiveFiniteNumber(streaming.maxLatencyMs)
        ? streaming.maxLatencyMs
        : DEFAULT_POLICY_SETTINGS.streaming.maxLatencyMs,
      earlyTermination:
        typeof streaming.earlyTermination === 'boolean'
          ? streaming.earlyTermination
          : DEFAULT_POLICY_SETTINGS.streaming.earlyTermination,
    },
    ...(typeof raw.webhookUrl === 'string' && raw.webhookUrl.trim().length > 0
      ? { webhookUrl: raw.webhookUrl.trim() }
      : {}),
    ...(typeof raw.encryptedWebhookSecret === 'string' && raw.encryptedWebhookSecret.length > 0
      ? { encryptedWebhookSecret: raw.encryptedWebhookSecret }
      : {}),
  };
}

function normalizeStoredCaching(caching: unknown): NormalizedCaching {
  if (!caching || typeof caching !== 'object' || Array.isArray(caching)) {
    return { ...DEFAULT_POLICY_CACHING };
  }

  const raw = caching as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_POLICY_CACHING.enabled,
    exactMatch:
      typeof raw.exactMatch === 'boolean' ? raw.exactMatch : DEFAULT_POLICY_CACHING.exactMatch,
    semanticMatch:
      typeof raw.semanticMatch === 'boolean'
        ? raw.semanticMatch
        : DEFAULT_POLICY_CACHING.semanticMatch,
    semanticThreshold:
      typeof raw.semanticThreshold === 'number' && Number.isFinite(raw.semanticThreshold)
        ? raw.semanticThreshold
        : DEFAULT_POLICY_CACHING.semanticThreshold,
    defaultTtlSeconds:
      typeof raw.defaultTtlSeconds === 'number' &&
      Number.isFinite(raw.defaultTtlSeconds) &&
      raw.defaultTtlSeconds > 0
        ? Math.floor(raw.defaultTtlSeconds)
        : DEFAULT_POLICY_CACHING.defaultTtlSeconds,
  };
}

function normalizeStoredBudget(budget: unknown): NormalizedBudget {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    return { ...DEFAULT_POLICY_BUDGET };
  }

  const raw = budget as Record<string, unknown>;
  return {
    monthlyLimitUsd: isPositiveFiniteNumber(raw.monthlyLimitUsd)
      ? raw.monthlyLimitUsd
      : DEFAULT_POLICY_BUDGET.monthlyLimitUsd,
    currentSpendUsd: isNonNegativeFiniteNumber(raw.currentSpendUsd)
      ? raw.currentSpendUsd
      : DEFAULT_POLICY_BUDGET.currentSpendUsd,
    overspendAction:
      raw.overspendAction === 'downgrade' ||
      raw.overspendAction === 'disable_model_checks' ||
      raw.overspendAction === 'alert_only'
        ? raw.overspendAction
        : DEFAULT_POLICY_BUDGET.overspendAction,
  };
}

/** Fields that must be present on create */
const REQUIRED_CREATE_FIELDS = ['name', 'settings'] as const;

/** Fields that cannot be set/overridden by the client */
const PROTECTED_FIELDS = new Set([
  'tenantId',
  'scope',
  'scopeType',
  'agentDefId',
  'isActive',
  '_id',
  '_v',
  'createdAt',
  'updatedAt',
]);

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

/**
 * Build a guardrail policy scope from the request body.
 * Supports `scopeType: 'agent'` with a required `agentDefId`,
 * otherwise defaults to `{ type: 'project', projectId }`.
 *
 * Returns `{ scope }` on success or `{ error, message }` on validation failure.
 */
function buildScope(
  body: Record<string, unknown>,
  context: RouteScopeContext,
): { scope: GuardrailPolicyScope } | { error: string; message: string } {
  const scopeType = body.scopeType as string | undefined;

  if (context.level === 'tenant') {
    if (scopeType && scopeType !== 'tenant') {
      return {
        error: 'VALIDATION_ERROR',
        message: 'scopeType must be "tenant" when using the tenant guardrail route',
      };
    }
    return { scope: { type: 'tenant' } };
  }

  if (scopeType === 'agent') {
    const agentDefId = body.agentDefId as string | undefined;
    if (!agentDefId || typeof agentDefId !== 'string' || agentDefId.trim().length === 0) {
      return {
        error: 'VALIDATION_ERROR',
        message: 'agentDefId is required when scopeType is "agent"',
      };
    }
    return {
      scope: { type: 'agent', projectId: context.projectId, agentDefId: agentDefId.trim() },
    };
  }

  if (scopeType && scopeType !== 'project') {
    return {
      error: 'VALIDATION_ERROR',
      message: 'scopeType must be "project" or "agent"',
    };
  }

  return { scope: { type: 'project', projectId: context.projectId } };
}

function getValidStatus(value: unknown): 'draft' | 'active' | 'archived' | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'draft' || value === 'active' || value === 'archived') {
    return value;
  }
  return null;
}

function normalizeLifecycle(status: 'draft' | 'active' | 'archived') {
  return {
    status,
    isActive: status === 'active',
  };
}

function stripWebhookSettings(
  settings: NormalizedSettings,
): Omit<NormalizedSettings, 'webhookUrl' | 'encryptedWebhookSecret'> {
  const {
    webhookUrl: _webhookUrl,
    encryptedWebhookSecret: _encryptedWebhookSecret,
    ...rest
  } = settings;
  return rest;
}

function validateOperationalControlScope(
  scope: GuardrailPolicyScope,
  body: Record<string, unknown>,
): { error: string; message: string } | null {
  if (scope.type === 'project') {
    return null;
  }

  const settings =
    body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
      ? (body.settings as Record<string, unknown>)
      : undefined;
  const hasWebhookFields = Boolean(
    settings && (hasOwnKey(settings, 'webhookUrl') || hasOwnKey(settings, 'webhookSecret')),
  );

  if (body.caching !== undefined || body.budget !== undefined || hasWebhookFields) {
    return {
      error: 'VALIDATION_ERROR',
      message:
        'caching, budget, and webhook settings are only supported on project-scoped guardrail policies',
    };
  }

  return null;
}

async function normalizePolicyForResponse<T extends Record<string, unknown>>(policy: T) {
  const status =
    policy.status === 'active' || policy.status === 'archived' ? policy.status : 'draft';
  const scope =
    policy.scope && typeof policy.scope === 'object'
      ? (policy.scope as GuardrailPolicyScope)
      : ({ type: 'tenant' } satisfies GuardrailPolicyScope);
  const settings = normalizeStoredSettings(policy.settings);
  const { encryptedWebhookSecret: _enc, ...settingsWithoutSecret } = settings;
  const projectSettings =
    scope.type === 'project'
      ? {
          ...settingsWithoutSecret,
          webhookSecretConfigured: Boolean(settings.encryptedWebhookSecret),
        }
      : undefined;
  const response: Record<string, unknown> = {
    ...policy,
    providerOverrides: sanitizeProviderOverridesForResponse(policy.providerOverrides),
    settings: scope.type === 'project' ? projectSettings : stripWebhookSettings(settings),
    status,
    isActive: status === 'active',
  };

  if (scope.type === 'project') {
    const tracker = getSharedCostTracker();
    const tenantId = typeof policy.tenantId === 'string' ? policy.tenantId : '';
    const currentSpendUsd =
      scope.projectId && tenantId ? await tracker.getCurrentSpend(tenantId, scope.projectId) : 0;
    response.caching = normalizeStoredCaching(policy.caching);
    response.budget = {
      ...normalizeStoredBudget(policy.budget),
      currentSpendUsd,
    };
  } else {
    delete response.caching;
    delete response.budget;
  }

  return response;
}

async function deactivateSiblingPolicies(
  tenantId: string,
  scope: GuardrailPolicyScope,
  activePolicyId?: string,
): Promise<void> {
  const filter: Record<string, unknown> = {
    tenantId,
    $or: [{ status: 'active' }, { isActive: true }],
  };

  if (scope.type === 'tenant') {
    filter['scope.type'] = 'tenant';
  } else if (scope.type === 'agent') {
    filter['scope.type'] = 'agent';
    filter['scope.projectId'] = scope.projectId;
    filter['scope.agentDefId'] = scope.agentDefId;
  } else {
    filter['scope.type'] = 'project';
    filter['scope.projectId'] = scope.projectId;
  }

  if (activePolicyId) {
    filter._id = { $ne: activePolicyId };
  }

  await GuardrailPolicy.updateMany(filter, {
    $set: { status: 'draft', isActive: false },
  });
}

async function bumpAffectedPolicyEpochs(
  tenantId: string,
  scope: GuardrailPolicyScope,
): Promise<void> {
  if (scope.type === 'tenant') {
    const projects: Array<{ _id: unknown }> = await Project.find({ tenantId })
      .select({ _id: 1 })
      .limit(200)
      .lean();
    if (projects.length === 200) {
      log.warn('bumpAffectedPolicyEpochs: tenant project list truncated at 200', { tenantId });
    }
    await Promise.all(
      projects.map((project) => bumpGuardrailPolicyEpoch(tenantId, String(project._id))),
    );
    return;
  }

  if (scope.projectId) {
    await bumpGuardrailPolicyEpoch(tenantId, scope.projectId);
  }
}

/**
 * Normalize rules from the client body to match the DB schema.
 *
 * Handles legacy payloads where the Studio YAML editor or older form code sent:
 *   - `name` instead of the required `guardrailName`
 *   - no `override` field (required by schema)
 *   - `kind: 'both'` which is not a valid DB enum — expands to input + output
 */
function normalizeRules(
  rules: unknown,
): Record<string, unknown>[] | { error: string; message: string } {
  if (!Array.isArray(rules)) return [];
  const out: Record<string, unknown>[] = [];
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    const rule = { ...(r as Record<string, unknown>) };

    if (rule.guardrailName === undefined && typeof rule.name === 'string') {
      rule.guardrailName = rule.name;
      delete rule.name;
    }

    if (rule.override === undefined) {
      rule.override = 'define';
    }

    const guardrailName =
      typeof rule.guardrailName === 'string' ? rule.guardrailName.trim() : undefined;
    if (!guardrailName) {
      continue;
    }
    rule.guardrailName = guardrailName;

    // ─── Preserve ABLP-723 Sensitive Data Block fields (round-trip identity) ──
    // Type-check each field; strip malformed values so only valid shapes persist.
    // Legacy rules without these fields are unaffected (the keys stay absent).
    if (rule.entities !== undefined) {
      if (!Array.isArray(rule.entities)) {
        delete rule.entities;
      }
    }
    if (rule.enabled !== undefined) {
      rule.enabled = rule.enabled === true || rule.enabled === false ? rule.enabled : undefined;
      if (rule.enabled === undefined) delete rule.enabled;
    }
    if (rule.presetKey !== undefined) {
      rule.presetKey =
        typeof rule.presetKey === 'string' && rule.presetKey.trim()
          ? rule.presetKey.trim()
          : undefined;
      if (rule.presetKey === undefined) delete rule.presetKey;
    }
    if (rule.actionMessage !== undefined) {
      rule.actionMessage = typeof rule.actionMessage === 'string' ? rule.actionMessage : undefined;
      if (rule.actionMessage === undefined) delete rule.actionMessage;
    }

    const expandedRules =
      rule.kind === 'both'
        ? [
            { ...rule, kind: 'input' },
            { ...rule, kind: 'output' },
          ]
        : [rule];

    for (const normalizedRule of expandedRules) {
      if (normalizedRule.override === 'define') {
        const hasExecutableCheck = Boolean(
          (typeof normalizedRule.check === 'string' && normalizedRule.check.trim()) ||
          (typeof normalizedRule.provider === 'string' && normalizedRule.provider.trim()) ||
          (typeof normalizedRule.llmCheck === 'string' && normalizedRule.llmCheck.trim()),
        );

        if (!hasExecutableCheck) {
          // SDB preset rules submitted with override=define but no executable check
          // are intentionally incomplete — reject rather than silently drop.
          if (normalizedRule.presetKey === 'sensitive_data_block') {
            return {
              error: 'RULE_INCOMPLETE',
              message: `SDB rule '${String(normalizedRule.guardrailName)}' requires a provider, check, or llmCheck when override is 'define'`,
            };
          }
          if (rule.kind === 'both') {
            log.warn('normalizeRules: kind=both expansion dropped incomplete define rule', {
              guardrailName: normalizedRule.guardrailName,
              expandedKind: normalizedRule.kind,
            });
          }
          continue;
        }
      }

      out.push(normalizedRule);
    }
  }
  return out;
}

/**
 * Map a Mongoose-shaped rule (from normalizeRules output) to the Studio-form
 * vocabulary that `validateRule()` expects.
 *
 * Key differences:
 *  - Mongoose: `guardrailName`  →  Studio: `name`
 *  - Mongoose: no explicit `checkType`  →  Studio: `checkType` inferred from
 *    which executable-check field is populated (provider / check / llmCheck).
 */
function toValidationInput(rule: Record<string, unknown>): GuardrailRuleInput {
  // Infer checkType from the executable-check fields
  let checkType: string | undefined;
  if (typeof rule.provider === 'string' && rule.provider.trim()) {
    checkType = 'provider';
  } else if (typeof rule.check === 'string' && rule.check.trim()) {
    checkType = 'cel';
  } else if (typeof rule.llmCheck === 'string' && rule.llmCheck.trim()) {
    checkType = 'llm';
  }

  return {
    name: typeof rule.guardrailName === 'string' ? rule.guardrailName : undefined,
    checkType,
    kind: typeof rule.kind === 'string' ? rule.kind : undefined,
    threshold: typeof rule.threshold === 'number' ? rule.threshold : undefined,
    severityThreshold:
      typeof rule.severityThreshold === 'number' ? rule.severityThreshold : undefined,
    provider: typeof rule.provider === 'string' ? rule.provider : undefined,
    category: typeof rule.category === 'string' ? rule.category : undefined,
    check: typeof rule.check === 'string' ? rule.check : undefined,
    llmCheck: typeof rule.llmCheck === 'string' ? rule.llmCheck : undefined,
    action: typeof rule.action === 'string' ? rule.action : undefined,
    enabled: typeof rule.enabled === 'boolean' ? rule.enabled : undefined,
    entities: Array.isArray(rule.entities) ? (rule.entities as string[]) : undefined,
    presetKey: typeof rule.presetKey === 'string' ? rule.presetKey : undefined,
    actionMessage: typeof rule.actionMessage === 'string' ? rule.actionMessage : undefined,
    message: typeof rule.message === 'string' ? rule.message : undefined,
  };
}

/**
 * Server-side validation of normalized rules via the shared `validateRule()`.
 *
 * - **SDB rules** (`presetKey === 'sensitive_data_block'`): rejects with 400
 *   when `validateRule` returns `valid === false` (covers actionMessage
 *   null-bytes, over-length, empty-when-required).
 * - **All rules**: the persisted `actionMessage` is always the sanitized value
 *   (HTML-stripped) from `validateRule().sanitized`, never the raw input.
 *
 * Returns `null` on success (rules are mutated in place with sanitized values),
 * or `{ error, message }` on the first failing SDB rule.
 */
function validateRulesServerSide(
  rules: Record<string, unknown>[],
): { error: string; message: string } | null {
  for (const rule of rules) {
    const input = toValidationInput(rule);
    const result = validateRule(input);

    // Always replace actionMessage with sanitized value (HTML-stripped)
    if (result.sanitized.actionMessage !== undefined) {
      rule.actionMessage = result.sanitized.actionMessage;
    } else if (rule.actionMessage !== undefined) {
      // Sanitization rejected the raw value — remove it
      delete rule.actionMessage;
    }

    // Only enforce strict validation for SDB rules
    const isSDB = rule.presetKey === 'sensitive_data_block';
    if (isSDB && !result.valid) {
      return {
        error: 'RULE_INCOMPLETE',
        message: `Sensitive Data Block rule "${input.name ?? 'unknown'}" is incomplete: ${result.missingFields.join(', ')}`,
      };
    }
  }
  return null;
}

function validateRuleNumericControls(
  rules: Record<string, unknown>[],
): { error: string; message: string } | null {
  for (const rule of rules) {
    if (hasOwnKey(rule, 'threshold') && !isUnitIntervalNumber(rule.threshold)) {
      return {
        error: 'VALIDATION_ERROR',
        message: 'rules.threshold must be a number between 0 and 1',
      };
    }
  }

  return null;
}

function sanitizeProviderOverridesForResponse(overrides: unknown): Record<string, unknown>[] {
  if (!Array.isArray(overrides)) {
    return [];
  }

  return overrides.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const override = entry as Record<string, unknown>;
    const providerName =
      typeof override.providerName === 'string' ? override.providerName.trim() : undefined;
    if (!providerName) {
      return [];
    }

    return [
      {
        providerName,
        ...(typeof override.endpoint === 'string' && override.endpoint.trim()
          ? { endpoint: override.endpoint.trim() }
          : {}),
        ...(typeof override.defaultCategory === 'string' && override.defaultCategory.trim()
          ? { defaultCategory: override.defaultCategory.trim() }
          : {}),
        ...(isUnitIntervalNumber(override.defaultThreshold)
          ? { defaultThreshold: override.defaultThreshold }
          : {}),
        ...(isNonNegativeFiniteNumber(override.costPerEvalUsd)
          ? { costPerEvalUsd: override.costPerEvalUsd }
          : {}),
        ...(typeof override.isActive === 'boolean' ? { isActive: override.isActive } : {}),
        ...(override.circuitBreaker && typeof override.circuitBreaker === 'object'
          ? { circuitBreaker: override.circuitBreaker }
          : {}),
        ...(override.retry && typeof override.retry === 'object' ? { retry: override.retry } : {}),
      },
    ];
  });
}

function normalizeProviderOverrides(
  overrides: unknown,
): { providerOverrides?: Record<string, unknown>[] } | { error: string; message: string } {
  if (overrides === undefined) {
    return {};
  }
  if (!Array.isArray(overrides)) {
    return {
      error: 'VALIDATION_ERROR',
      message: 'providerOverrides must be an array when provided',
    };
  }

  const sanitized = sanitizeProviderOverridesForResponse(overrides);
  for (const entry of overrides as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== 'object') {
      return {
        error: 'VALIDATION_ERROR',
        message: 'Each provider override must be an object',
      };
    }

    if ('apiKeyCredentialId' in entry || 'authProfileId' in entry) {
      return {
        error: 'VALIDATION_ERROR',
        message:
          'provider credential overrides are not supported in guardrail policies yet; use provider configuration instead',
      };
    }

    if (hasOwnKey(entry, 'defaultThreshold') && !isUnitIntervalNumber(entry.defaultThreshold)) {
      return {
        error: 'VALIDATION_ERROR',
        message: 'providerOverrides.defaultThreshold must be a number between 0 and 1',
      };
    }

    if (hasOwnKey(entry, 'costPerEvalUsd') && !isNonNegativeFiniteNumber(entry.costPerEvalUsd)) {
      return {
        error: 'VALIDATION_ERROR',
        message: 'providerOverrides.costPerEvalUsd must be a non-negative number',
      };
    }
  }

  return { providerOverrides: sanitized };
}

function normalizeCaching(
  caching: unknown,
  base: NormalizedCaching = DEFAULT_POLICY_CACHING,
): { caching?: Record<string, unknown> } | { error: string; message: string } {
  if (caching === undefined) {
    return {};
  }
  if (!caching || typeof caching !== 'object' || Array.isArray(caching)) {
    return {
      error: 'VALIDATION_ERROR',
      message: 'caching must be an object when provided',
    };
  }

  const config = caching as Record<string, unknown>;
  if (config.semanticMatch === true) {
    return {
      error: 'VALIDATION_ERROR',
      message: 'semanticMatch is not supported for guardrail policy caching yet',
    };
  }

  return {
    caching: {
      enabled: typeof config.enabled === 'boolean' ? config.enabled : base.enabled,
      exactMatch: typeof config.exactMatch === 'boolean' ? config.exactMatch : base.exactMatch,
      semanticMatch: false,
      semanticThreshold:
        typeof config.semanticThreshold === 'number' && Number.isFinite(config.semanticThreshold)
          ? config.semanticThreshold
          : base.semanticThreshold,
      defaultTtlSeconds:
        typeof config.defaultTtlSeconds === 'number' &&
        Number.isFinite(config.defaultTtlSeconds) &&
        config.defaultTtlSeconds > 0
          ? Math.floor(config.defaultTtlSeconds)
          : base.defaultTtlSeconds,
    },
  };
}

function normalizeSettings(
  settings: unknown,
  base: NormalizedSettings = DEFAULT_POLICY_SETTINGS,
): { settings?: Record<string, unknown> } | { error: string; message: string } {
  if (settings === undefined) {
    return {};
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return {
      error: 'VALIDATION_ERROR',
      message: 'settings must be an object when provided',
    };
  }

  const incoming = settings as Record<string, unknown>;
  const normalized: NormalizedSettings = {
    failMode:
      incoming.failMode === 'open'
        ? 'open'
        : incoming.failMode === 'closed'
          ? 'closed'
          : base.failMode,
    timeouts: { ...base.timeouts },
    streaming: { ...base.streaming },
  };

  if (incoming.timeouts !== undefined) {
    if (
      !incoming.timeouts ||
      typeof incoming.timeouts !== 'object' ||
      Array.isArray(incoming.timeouts)
    ) {
      return {
        error: 'VALIDATION_ERROR',
        message: 'settings.timeouts must be an object when provided',
      };
    }
    const timeouts = incoming.timeouts as Record<string, unknown>;
    for (const key of ['local', 'model', 'llm'] as const) {
      if (hasOwnKey(timeouts, key) && !isPositiveFiniteNumber(timeouts[key])) {
        return {
          error: 'VALIDATION_ERROR',
          message: `settings.timeouts.${key} must be a positive number`,
        };
      }
    }
    normalized.timeouts = {
      local: isPositiveFiniteNumber(timeouts.local) ? timeouts.local : base.timeouts.local,
      model: isPositiveFiniteNumber(timeouts.model) ? timeouts.model : base.timeouts.model,
      llm: isPositiveFiniteNumber(timeouts.llm) ? timeouts.llm : base.timeouts.llm,
    };
  }

  if (incoming.streaming !== undefined) {
    if (
      !incoming.streaming ||
      typeof incoming.streaming !== 'object' ||
      Array.isArray(incoming.streaming)
    ) {
      return {
        error: 'VALIDATION_ERROR',
        message: 'settings.streaming must be an object when provided',
      };
    }
    const streaming = incoming.streaming as Record<string, unknown>;
    if (hasOwnKey(streaming, 'chunkSize') && !isPositiveFiniteNumber(streaming.chunkSize)) {
      return {
        error: 'VALIDATION_ERROR',
        message: 'settings.streaming.chunkSize must be a positive number',
      };
    }
    if (hasOwnKey(streaming, 'maxLatencyMs') && !isPositiveFiniteNumber(streaming.maxLatencyMs)) {
      return {
        error: 'VALIDATION_ERROR',
        message: 'settings.streaming.maxLatencyMs must be a positive number',
      };
    }
    normalized.streaming = {
      enabled: typeof streaming.enabled === 'boolean' ? streaming.enabled : base.streaming.enabled,
      defaultInterval:
        streaming.defaultInterval === 'token' ||
        streaming.defaultInterval === 'sentence' ||
        streaming.defaultInterval === 'chunk_size'
          ? streaming.defaultInterval
          : base.streaming.defaultInterval,
      chunkSize: isPositiveFiniteNumber(streaming.chunkSize)
        ? streaming.chunkSize
        : base.streaming.chunkSize,
      maxLatencyMs: isPositiveFiniteNumber(streaming.maxLatencyMs)
        ? streaming.maxLatencyMs
        : base.streaming.maxLatencyMs,
      earlyTermination:
        typeof streaming.earlyTermination === 'boolean'
          ? streaming.earlyTermination
          : base.streaming.earlyTermination,
    };
  }

  const hasWebhookUrl = hasOwnKey(incoming, 'webhookUrl');
  const hasWebhookSecret = hasOwnKey(incoming, 'webhookSecret');
  const webhookUrl = hasWebhookUrl
    ? typeof incoming.webhookUrl === 'string' && incoming.webhookUrl.trim().length > 0
      ? incoming.webhookUrl.trim()
      : undefined
    : base.webhookUrl;
  // New plaintext secret from request (to be encrypted by the caller before storage)
  const newPlaintextSecret = hasWebhookSecret
    ? typeof incoming.webhookSecret === 'string' && incoming.webhookSecret.trim().length > 0
      ? incoming.webhookSecret.trim()
      : undefined
    : null; // null = caller did not touch the secret field
  // Effective "has secret" for paired validation
  const effectiveHasSecret =
    newPlaintextSecret !== null
      ? Boolean(newPlaintextSecret)
      : Boolean(base.encryptedWebhookSecret);

  if ((webhookUrl && !effectiveHasSecret) || (!webhookUrl && effectiveHasSecret)) {
    return {
      error: 'VALIDATION_ERROR',
      message: 'webhookUrl and webhookSecret must be provided together',
    };
  }

  if (webhookUrl) {
    normalized.webhookUrl = webhookUrl;
    if (newPlaintextSecret) {
      // Caller must encrypt this before storing
      normalized.webhookSecret = newPlaintextSecret;
    } else if (base.encryptedWebhookSecret) {
      // Preserve the existing encrypted secret unchanged
      normalized.encryptedWebhookSecret = base.encryptedWebhookSecret;
    }
  }

  return { settings: normalized };
}

function normalizeBudget(
  budget: unknown,
  base: NormalizedBudget = DEFAULT_POLICY_BUDGET,
): { budget?: Record<string, unknown> } | { error: string; message: string } {
  if (budget === undefined) {
    return {};
  }
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    return {
      error: 'VALIDATION_ERROR',
      message: 'budget must be an object when provided',
    };
  }

  const config = budget as Record<string, unknown>;
  if (hasOwnKey(config, 'monthlyLimitUsd') && !isPositiveFiniteNumber(config.monthlyLimitUsd)) {
    return {
      error: 'VALIDATION_ERROR',
      message: 'budget.monthlyLimitUsd must be a positive number',
    };
  }

  return {
    budget: {
      monthlyLimitUsd: isPositiveFiniteNumber(config.monthlyLimitUsd)
        ? config.monthlyLimitUsd
        : base.monthlyLimitUsd,
      currentSpendUsd: base.currentSpendUsd,
      overspendAction:
        config.overspendAction === 'downgrade' ||
        config.overspendAction === 'disable_model_checks' ||
        config.overspendAction === 'alert_only'
          ? config.overspendAction
          : base.overspendAction,
    },
  };
}

// =============================================================================
// LIST — GET /
// =============================================================================

router.get('/', async (req: any, res) => {
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

    const context = getRouteScopeContext(req);
    if (!(await requireRouteScopePermission(req, res, context, 'guardrail:read'))) return;
    const policies = await GuardrailPolicy.find(buildScopedPolicyFilter(tenantId, context))
      .sort({ name: 1 })
      .lean();

    res.json({
      success: true,
      data: await Promise.all(
        policies.map((policy: Record<string, unknown>) => normalizePolicyForResponse(policy)),
      ),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to list guardrail policies', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list guardrail policies' },
    });
  }
});

// =============================================================================
// CREATE — POST /
// =============================================================================

router.post('/', async (req: any, res) => {
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

    const context = getRouteScopeContext(req);
    if (!(await requireRouteScopePermission(req, res, context, 'guardrail:write'))) return;

    // Validate required fields
    const missing = REQUIRED_CREATE_FIELDS.filter(
      (f) => req.body[f] === undefined || req.body[f] === null,
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

    // Build scope from optional scopeType + agentDefId fields
    const scopeResult = buildScope(req.body, context);
    if ('error' in scopeResult) {
      res.status(400).json({
        success: false,
        error: { code: scopeResult.error, message: scopeResult.message },
      });
      return;
    }

    const requestedStatus = getValidStatus(req.body.status);
    if (requestedStatus === null) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'status must be draft, active, or archived' },
      });
      return;
    }

    const sanitized = sanitizeBody(req.body);
    if (sanitized.rules !== undefined) {
      const normalizedRules = normalizeRules(sanitized.rules);
      if (!Array.isArray(normalizedRules)) {
        res.status(400).json({
          success: false,
          error: { code: normalizedRules.error, message: normalizedRules.message },
        });
        return;
      }
      sanitized.rules = normalizedRules;
    }
    const ruleNumericError = validateRuleNumericControls(
      Array.isArray(sanitized.rules) ? (sanitized.rules as Record<string, unknown>[]) : [],
    );
    if (ruleNumericError) {
      res.status(400).json({
        success: false,
        error: { code: ruleNumericError.error, message: ruleNumericError.message },
      });
      return;
    }
    // ABLP-723: server-side rule validation (sanitize actionMessage, enforce SDB completeness)
    const ruleValidationError = validateRulesServerSide(
      Array.isArray(sanitized.rules) ? (sanitized.rules as Record<string, unknown>[]) : [],
    );
    if (ruleValidationError) {
      res.status(400).json({
        success: false,
        error: { code: ruleValidationError.error, message: ruleValidationError.message },
      });
      return;
    }
    const operationalScopeError = validateOperationalControlScope(scopeResult.scope, sanitized);
    if (operationalScopeError) {
      res.status(400).json({
        success: false,
        error: { code: operationalScopeError.error, message: operationalScopeError.message },
      });
      return;
    }
    const providerOverrideResult = normalizeProviderOverrides(sanitized.providerOverrides);
    if ('error' in providerOverrideResult) {
      res.status(400).json({
        success: false,
        error: { code: providerOverrideResult.error, message: providerOverrideResult.message },
      });
      return;
    }
    Object.assign(sanitized, providerOverrideResult);

    const cachingResult = normalizeCaching(sanitized.caching);
    if ('error' in cachingResult) {
      res.status(400).json({
        success: false,
        error: { code: cachingResult.error, message: cachingResult.message },
      });
      return;
    }
    Object.assign(sanitized, cachingResult);

    const settingsResult = normalizeSettings(
      sanitized.settings,
      normalizeStoredSettings(sanitized.settings),
    );
    if ('error' in settingsResult) {
      res.status(400).json({
        success: false,
        error: { code: settingsResult.error, message: settingsResult.message },
      });
      return;
    }
    Object.assign(sanitized, settingsResult);
    const pendingSettings = sanitized.settings as NormalizedSettings | undefined;
    if (pendingSettings?.webhookSecret) {
      const projectId =
        scopeResult.scope.type === 'project' ? scopeResult.scope.projectId : undefined;
      pendingSettings.encryptedWebhookSecret = await encryptForTenantAuto(
        pendingSettings.webhookSecret,
        tenantId,
        projectId,
      );
      delete pendingSettings.webhookSecret;
    }
    const budgetResult = normalizeBudget(sanitized.budget);
    if ('error' in budgetResult) {
      res.status(400).json({
        success: false,
        error: { code: budgetResult.error, message: budgetResult.message },
      });
      return;
    }
    Object.assign(sanitized, budgetResult);
    const lifecycle = normalizeLifecycle(requestedStatus ?? 'draft');
    const policy = await GuardrailPolicy.create({
      ...sanitized,
      ...lifecycle,
      tenantId,
      scope: scopeResult.scope,
    });

    if (lifecycle.isActive) {
      await deactivateSiblingPolicies(tenantId, scopeResult.scope, String(policy._id));
    }

    const userId = req.tenantContext?.userId;
    log.info('Guardrail policy created', {
      tenantId,
      projectId: scopeResult.scope.projectId,
      name: policy.name,
      requestId,
    });
    writeAuditLog({
      action: 'guardrail-policy:create',
      tenantId,
      userId,
      metadata: {
        policyId: policy._id,
        name: policy.name,
        projectId: scopeResult.scope.projectId,
        requestId,
      },
    });

    await bumpAffectedPolicyEpochs(tenantId, scopeResult.scope);
    // Invalidate cached eval results so new policy thresholds take effect
    invalidateGuardrailEvalCache(tenantId);
    invalidateTenantProviderCache(tenantId);

    res.status(201).json({
      success: true,
      data: await normalizePolicyForResponse(policy.toObject()),
    });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    // Handle duplicate key errors from scoped guardrail policy name uniqueness.
    if (err?.code === 11000) {
      res.status(409).json({
        success: false,
        error: { code: 'DUPLICATE', message: 'A guardrail policy with this name already exists' },
      });
      return;
    }
    log.error('Failed to create guardrail policy', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create guardrail policy' },
    });
  }
});

// =============================================================================
// GET BY ID — GET /:id
// =============================================================================

router.get('/:id', async (req: any, res) => {
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

    const context = getRouteScopeContext(req);
    if (!(await requireRouteScopePermission(req, res, context, 'guardrail:read'))) return;
    const policy = await GuardrailPolicy.findOne(
      buildScopedPolicyFilter(tenantId, context, req.params.id),
    ).lean();

    if (!policy) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Guardrail policy not found' },
      });
      return;
    }

    res.json({ success: true, data: await normalizePolicyForResponse(policy) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to get guardrail policy', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get guardrail policy' },
    });
  }
});

// =============================================================================
// UPDATE — PUT /:id
// =============================================================================

router.put('/:id', async (req: any, res) => {
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

    const context = getRouteScopeContext(req);
    if (!(await requireRouteScopePermission(req, res, context, 'guardrail:write'))) return;

    const requestedStatus = getValidStatus(req.body.status);
    if (requestedStatus === null) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'status must be draft, active, or archived' },
      });
      return;
    }

    // If scopeType is provided, rebuild the scope; otherwise leave scope unchanged
    const hasScopeUpdate = req.body.scopeType !== undefined || req.body.agentDefId !== undefined;
    let scopeUpdate: Record<string, unknown> = {};
    if (hasScopeUpdate) {
      const scopeResult = buildScope(req.body, context);
      if ('error' in scopeResult) {
        res.status(400).json({
          success: false,
          error: { code: scopeResult.error, message: scopeResult.message },
        });
        return;
      }
      scopeUpdate = { scope: scopeResult.scope };
    }

    const existing = await GuardrailPolicy.findOne(
      buildScopedPolicyFilter(tenantId, context, req.params.id),
    ).lean();

    if (!existing) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Guardrail policy not found' },
      });
      return;
    }

    const sanitized = sanitizeBody(req.body);
    if (sanitized.rules !== undefined) {
      const normalizedRules = normalizeRules(sanitized.rules);
      if (!Array.isArray(normalizedRules)) {
        res.status(400).json({
          success: false,
          error: { code: normalizedRules.error, message: normalizedRules.message },
        });
        return;
      }
      sanitized.rules = normalizedRules;
    }
    const ruleNumericError = validateRuleNumericControls(
      Array.isArray(sanitized.rules) ? (sanitized.rules as Record<string, unknown>[]) : [],
    );
    if (ruleNumericError) {
      res.status(400).json({
        success: false,
        error: { code: ruleNumericError.error, message: ruleNumericError.message },
      });
      return;
    }
    // ABLP-723: server-side rule validation (sanitize actionMessage, enforce SDB completeness)
    const ruleValidationError = validateRulesServerSide(
      Array.isArray(sanitized.rules) ? (sanitized.rules as Record<string, unknown>[]) : [],
    );
    if (ruleValidationError) {
      res.status(400).json({
        success: false,
        error: { code: ruleValidationError.error, message: ruleValidationError.message },
      });
      return;
    }
    const effectiveScope =
      (scopeUpdate.scope as GuardrailPolicyScope | undefined) ??
      (existing.scope as GuardrailPolicyScope | undefined) ??
      ({ type: 'tenant' } satisfies GuardrailPolicyScope);
    const operationalScopeError = validateOperationalControlScope(effectiveScope, sanitized);
    if (operationalScopeError) {
      res.status(400).json({
        success: false,
        error: { code: operationalScopeError.error, message: operationalScopeError.message },
      });
      return;
    }
    const providerOverrideResult = normalizeProviderOverrides(sanitized.providerOverrides);
    if ('error' in providerOverrideResult) {
      res.status(400).json({
        success: false,
        error: { code: providerOverrideResult.error, message: providerOverrideResult.message },
      });
      return;
    }
    Object.assign(sanitized, providerOverrideResult);

    const cachingResult = normalizeCaching(
      sanitized.caching,
      normalizeStoredCaching(existing.caching),
    );
    if ('error' in cachingResult) {
      res.status(400).json({
        success: false,
        error: { code: cachingResult.error, message: cachingResult.message },
      });
      return;
    }
    Object.assign(sanitized, cachingResult);

    const settingsResult = normalizeSettings(
      sanitized.settings,
      normalizeStoredSettings(existing.settings),
    );
    if ('error' in settingsResult) {
      res.status(400).json({
        success: false,
        error: { code: settingsResult.error, message: settingsResult.message },
      });
      return;
    }
    Object.assign(sanitized, settingsResult);
    const pendingSettings = sanitized.settings as NormalizedSettings | undefined;
    if (pendingSettings?.webhookSecret) {
      const projectId = effectiveScope.type === 'project' ? effectiveScope.projectId : undefined;
      pendingSettings.encryptedWebhookSecret = await encryptForTenantAuto(
        pendingSettings.webhookSecret,
        tenantId,
        projectId,
      );
      delete pendingSettings.webhookSecret;
    }
    const budgetResult = normalizeBudget(sanitized.budget, normalizeStoredBudget(existing.budget));
    if ('error' in budgetResult) {
      res.status(400).json({
        success: false,
        error: { code: budgetResult.error, message: budgetResult.message },
      });
      return;
    }
    Object.assign(sanitized, budgetResult);
    const lifecycleUpdate =
      requestedStatus !== undefined ? normalizeLifecycle(requestedStatus) : undefined;

    // ABLP-723: if every rule is now disabled and the policy was active, the PUT
    // must atomically auto-deactivate. Built as a separate object so it can spread
    // LAST in the $set, overriding any client-supplied status:'active' that would
    // otherwise leak through lifecycleUpdate.
    //
    // The client serializer filters non-SDB disabled rules out of the payload
    // entirely (returns []), so an empty rules array on an active policy ALSO
    // means zero enabled rules — must trigger deactivation.
    const sanitizedRules = Array.isArray(sanitized.rules) ? sanitized.rules : [];
    const allDisabled =
      sanitizedRules.length === 0 || sanitizedRules.every((r: any) => r?.enabled === false);
    const autoDeactivated = allDisabled && existing.isActive === true;
    const autoDeactivationUpdate = autoDeactivated
      ? { isActive: false, status: 'draft' as const }
      : {};

    let updated = await GuardrailPolicy.findOneAndUpdate(
      buildScopedPolicyFilter(tenantId, context, req.params.id),
      {
        $set: {
          ...sanitized,
          ...scopeUpdate,
          ...(lifecycleUpdate ?? {}),
          ...autoDeactivationUpdate, // MUST be last spread to override lifecycle
        },
      },
      { new: true, runValidators: true },
    ).lean();

    if (lifecycleUpdate?.isActive) {
      const updatedScope =
        updated.scope && typeof updated.scope === 'object'
          ? (updated.scope as GuardrailPolicyScope)
          : undefined;
      if (updatedScope) {
        await deactivateSiblingPolicies(tenantId, updatedScope, req.params.id);
      }
      updated = await GuardrailPolicy.findOne(
        buildScopedPolicyFilter(tenantId, context, req.params.id),
      ).lean();

      if (!updated) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Guardrail policy not found' },
        });
        return;
      }
    }

    const userId = req.tenantContext?.userId;
    log.info('Guardrail policy updated', {
      tenantId,
      projectId:
        updated?.scope && typeof updated.scope === 'object'
          ? ((updated.scope as GuardrailPolicyScope).projectId ?? null)
          : null,
      policyId: req.params.id,
      requestId,
    });
    writeAuditLog({
      action: 'guardrail-policy:update',
      tenantId,
      userId,
      metadata: {
        policyId: req.params.id,
        fields: Object.keys(sanitized),
        projectId:
          updated?.scope && typeof updated.scope === 'object'
            ? ((updated.scope as GuardrailPolicyScope).projectId ?? null)
            : null,
        requestId,
      },
    });

    if (autoDeactivated) {
      writeAuditLog({
        action: 'guardrail-policy:auto-deactivated',
        tenantId,
        userId,
        metadata: {
          policyId: updated?._id,
          projectId: (updated?.scope as GuardrailPolicyScope | undefined)?.projectId ?? null,
          reason: 'all_rules_disabled',
          undone: false,
          requestId,
        },
      });
    }

    const updatedScope =
      updated?.scope && typeof updated.scope === 'object'
        ? (updated.scope as GuardrailPolicyScope)
        : undefined;
    if (updatedScope) {
      await bumpAffectedPolicyEpochs(tenantId, updatedScope);
    }
    // Invalidate cached eval results so updated thresholds/actions take effect
    invalidateGuardrailEvalCache(tenantId);
    invalidateTenantProviderCache(tenantId);

    res.json({
      success: true,
      data: await normalizePolicyForResponse(updated),
      autoDeactivated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to update guardrail policy', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update guardrail policy' },
    });
  }
});

// =============================================================================
// ACTIVATE — POST /:id/activate
// =============================================================================

router.post('/:id/activate', async (req: any, res) => {
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

    const context = getRouteScopeContext(req);
    if (!(await requireRouteScopePermission(req, res, context, 'guardrail:write'))) return;

    // Verify the policy exists with tenant+project isolation
    const existing = await GuardrailPolicy.findOne(
      buildScopedPolicyFilter(tenantId, context, req.params.id),
    ).lean();

    if (!existing) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Guardrail policy not found' },
      });
      return;
    }

    // ABLP-723: refuse activation if no rules are enabled.
    const hasEnabled =
      Array.isArray(existing.rules) && existing.rules.some((r: any) => r.enabled !== false);
    if (!hasEnabled) {
      writeAuditLog({
        action: 'guardrail-policy:activation-blocked',
        tenantId,
        userId: req.tenantContext?.userId,
        metadata: {
          policyId: existing._id,
          // projectId is null for tenant-scoped policies — intentional;
          // audit queries use tenantId as the primary partition key.
          projectId: (existing.scope as GuardrailPolicyScope | undefined)?.projectId ?? null,
          reason: 'no_enabled_rules',
          requestId,
        },
      });
      res.status(400).json({
        success: false,
        error: {
          code: 'NO_ENABLED_RULES',
          message: 'Cannot activate a policy with zero enabled rules.',
        },
      });
      return;
    }

    // Deactivate all other active or legacy-stale policies in the same project
    const existingScope =
      existing.scope && typeof existing.scope === 'object'
        ? (existing.scope as GuardrailPolicyScope)
        : ({ type: 'tenant' } satisfies GuardrailPolicyScope);
    await deactivateSiblingPolicies(tenantId, existingScope, req.params.id);

    // Activate the target policy (sync both status and isActive)
    const activated = await GuardrailPolicy.findOneAndUpdate(
      buildScopedPolicyFilter(tenantId, context, req.params.id),
      { $set: { status: 'active', isActive: true } },
      { new: true },
    ).lean();

    const userId = req.tenantContext?.userId;
    log.info('Guardrail policy activated', {
      tenantId,
      projectId: existingScope.projectId,
      policyId: req.params.id,
      requestId,
    });
    writeAuditLog({
      action: 'guardrail-policy:activate',
      tenantId,
      userId,
      metadata: { policyId: req.params.id, projectId: existingScope.projectId, requestId },
    });

    await bumpAffectedPolicyEpochs(tenantId, existingScope);
    // Invalidate cached eval results so the newly active policy takes effect
    invalidateGuardrailEvalCache(tenantId);
    invalidateTenantProviderCache(tenantId);

    res.json({ success: true, data: await normalizePolicyForResponse(activated ?? existing) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to activate guardrail policy', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to activate guardrail policy' },
    });
  }
});

// =============================================================================
// REACTIVATE — POST /:id/reactivate (atomic undo for auto-deactivation)
// =============================================================================

const ReactivateBodySchema = z
  .object({
    guardrailName: z.string().min(1),
  })
  .strict();

router.post('/:id/reactivate', async (req: any, res) => {
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

    const context = getRouteScopeContext(req);
    if (!(await requireRouteScopePermission(req, res, context, 'guardrail:write'))) return;

    const parsed = ReactivateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: parsed.error.message },
      });
      return;
    }
    const { guardrailName } = parsed.data;

    // Atomically re-enable the named rule AND reactivate the policy.
    // NOTE: `rules.guardrailName` is the match key because `GuardrailRuleSchema`
    // has `_id: false` — rules are addressed by their guardrailName, not an _id.
    // Mongo's `$` positional updates the FIRST matching rule; if `kind: 'both'`
    // produced two persisted rules with the same guardrailName, callers must
    // issue two reactivate calls (one per kind). The Studio undo handler maps
    // the disabled-rule set; the server route stays scoped to a single
    // positional update per call to preserve atomicity simplicity.
    const updated = await GuardrailPolicy.findOneAndUpdate(
      {
        ...buildScopedPolicyFilter(tenantId, context, req.params.id),
        'rules.guardrailName': guardrailName,
      },
      {
        $set: {
          'rules.$.enabled': true,
          isActive: true,
          status: 'active',
        },
      },
      { new: true, runValidators: true },
    ).lean();

    if (!updated) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Guardrail policy or rule not found' },
      });
      return;
    }

    // Mirror the `/:id/activate` post-write contract — without these calls,
    // two policies could be active in the same scope after an undo, and the
    // runtime would keep serving the stale (deactivated) policy until an
    // unrelated cache flush.
    const updatedScope =
      updated.scope && typeof updated.scope === 'object'
        ? (updated.scope as GuardrailPolicyScope)
        : ({ type: 'tenant' } satisfies GuardrailPolicyScope);
    await deactivateSiblingPolicies(tenantId, updatedScope, req.params.id);
    await bumpAffectedPolicyEpochs(tenantId, updatedScope);
    invalidateGuardrailEvalCache(tenantId);
    invalidateTenantProviderCache(tenantId);

    writeAuditLog({
      action: 'guardrail-policy:reactivated',
      tenantId,
      userId: req.tenantContext?.userId,
      metadata: {
        policyId: updated._id,
        projectId: updatedScope.projectId ?? null,
        guardrailName,
        undone: true,
        requestId,
      },
    });

    res.json({ success: true, data: await normalizePolicyForResponse(updated) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to reactivate guardrail policy', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to reactivate guardrail policy' },
    });
  }
});

// =============================================================================
// DELETE — DELETE /:id
// =============================================================================

router.delete('/:id', async (req: any, res) => {
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

    const context = getRouteScopeContext(req);
    if (!(await requireRouteScopePermission(req, res, context, 'guardrail:write'))) return;
    const deleted = await GuardrailPolicy.findOneAndDelete(
      buildScopedPolicyFilter(tenantId, context, req.params.id),
    ).lean();

    if (!deleted) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Guardrail policy not found' },
      });
      return;
    }

    const userId = req.tenantContext?.userId;
    log.info('Guardrail policy deleted', {
      tenantId,
      projectId:
        deleted.scope && typeof deleted.scope === 'object'
          ? ((deleted.scope as GuardrailPolicyScope).projectId ?? null)
          : null,
      policyId: req.params.id,
      requestId,
    });
    writeAuditLog({
      action: 'guardrail-policy:delete',
      tenantId,
      userId,
      metadata: {
        policyId: req.params.id,
        name: deleted.name,
        projectId:
          deleted.scope && typeof deleted.scope === 'object'
            ? ((deleted.scope as GuardrailPolicyScope).projectId ?? null)
            : null,
        requestId,
      },
    });

    const deletedScope =
      deleted.scope && typeof deleted.scope === 'object'
        ? (deleted.scope as GuardrailPolicyScope)
        : undefined;
    if (deletedScope) {
      await bumpAffectedPolicyEpochs(tenantId, deletedScope);
    }
    // Invalidate cached eval results so deleted policy rules stop applying
    invalidateGuardrailEvalCache(tenantId);
    invalidateTenantProviderCache(tenantId);

    res.json({ success: true, data: { id: req.params.id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to delete guardrail policy', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete guardrail policy' },
    });
  }
});

export default router;
