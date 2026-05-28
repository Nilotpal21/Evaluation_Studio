/**
 * Tenant LLM Policy Route
 *
 * CRUD for tenant-level LLM governance policies:
 * credential policy, allowed providers, project credentials, budgets.
 *
 * Mount: /api/tenants/:tenantId/llm-policy
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { findLLMPolicyOrDefaults, upsertLLMPolicy } from '../repos/tenant-llm-policy-repo.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import { invalidateModelResolutionCaches } from '../services/llm/model-cache-invalidation.js';

const log = createLogger('tenant-llm-policy-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/tenants/:tenantId/llm-policy',
  tags: ['Tenant LLM Policy'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(tenantRateLimit('request'));

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

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const VALID_CREDENTIAL_POLICIES = ['org_first', 'user_first', 'org_only', 'user_only'] as const;
const VALID_PROVIDERS = [
  'openai',
  'anthropic',
  'azure',
  'microsoft_foundry_anthropic',
  'google',
  'gemini',
  'vertex',
  'vertex_ai',
  'google_vertex',
  'groq',
  'mistral',
  'openrouter',
  'fireworks',
  'togetherai',
  'perplexity',
  'deepseek',
  'xai',
  'bedrock',
  'cohere',
  'ultravox',
  'custom',
] as const;
const policyResponseSchema = z.object({
  credentialPolicy: z.string(),
  allowedProviders: z.array(z.string()),
  allowProjectCredentials: z.boolean(),
  platformDemoEnabled: z.boolean(),
  monthlyTokenBudget: z.number(),
  dailyTokenBudget: z.number(),
  maxRequestsPerMinute: z.number(),
  defaultModel: z.string().nullable(),
  defaultFastModel: z.string().nullable(),
  defaultVoiceModel: z.string().nullable(),
});

const policyUpdateSchema = z.object({
  credentialPolicy: z.enum(VALID_CREDENTIAL_POLICIES).optional(),
  allowedProviders: z.array(z.string()).optional(),
  allowProjectCredentials: z.boolean().optional(),
  monthlyTokenBudget: z.number().min(0).optional(),
  dailyTokenBudget: z.number().min(0).optional(),
  maxRequestsPerMinute: z.number().min(0).optional(),
  defaultModel: z.string().nullable().optional(),
  defaultFastModel: z.string().nullable().optional(),
  defaultVoiceModel: z.string().nullable().optional(),
});

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET / — Fetch tenant LLM policy (or defaults)
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'Get tenant LLM policy',
    description:
      'Fetch the LLM governance policy for this tenant. Returns sensible defaults if no policy has been explicitly configured.',
    params: z.object({ tenantId: z.string() }),
    response: z.object({
      success: z.literal(true),
      policy: policyResponseSchema,
    }),
  },
  requirePermission('credential:read'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const policy = await findLLMPolicyOrDefaults(tenantId);

      res.json({
        success: true,
        policy: {
          credentialPolicy: policy.credentialPolicy,
          allowedProviders: policy.allowedProviders,
          allowProjectCredentials: policy.allowProjectCredentials,
          platformDemoEnabled: policy.platformDemoEnabled,
          monthlyTokenBudget: policy.monthlyTokenBudget,
          dailyTokenBudget: policy.dailyTokenBudget,
          maxRequestsPerMinute: policy.maxRequestsPerMinute,
          defaultModel: policy.defaultModel,
          defaultFastModel: policy.defaultFastModel,
          defaultVoiceModel: policy.defaultVoiceModel,
        },
      });
    } catch (error: any) {
      log.error('Failed to get LLM policy', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to get LLM policy' });
    }
  },
);

/**
 * PUT / — Upsert tenant LLM policy
 *
 * Note: platformDemoEnabled is excluded from updates — it is a superadmin-only field.
 */
openapi.route(
  'put',
  '/',
  {
    summary: 'Update tenant LLM policy',
    description:
      'Create or update the LLM governance policy for this tenant. Supports partial updates. The platformDemoEnabled field is read-only from this endpoint (superadmin only).',
    params: z.object({ tenantId: z.string() }),
    body: policyUpdateSchema,
    response: z.object({
      success: z.literal(true),
      policy: policyResponseSchema,
    }),
  },
  requirePermission('credential:write'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      const userId = req.tenantContext!.userId;

      // Validate allowed providers if provided
      if (req.body.allowedProviders) {
        const invalid = req.body.allowedProviders.filter(
          (p: string) => !(VALID_PROVIDERS as readonly string[]).includes(p),
        );
        if (invalid.length > 0) {
          res.status(400).json({
            success: false,
            error: `Invalid provider(s): ${invalid.join(', ')}. Valid providers: ${VALID_PROVIDERS.join(', ')}`,
          });
          return;
        }
      }

      // Build update data — explicitly exclude platformDemoEnabled
      const allowedFields = [
        'credentialPolicy',
        'allowedProviders',
        'allowProjectCredentials',
        'monthlyTokenBudget',
        'dailyTokenBudget',
        'maxRequestsPerMinute',
        'defaultModel',
        'defaultFastModel',
        'defaultVoiceModel',
      ];
      const data: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          data[field] = req.body[field];
        }
      }

      const updated = await upsertLLMPolicy(tenantId, data);
      invalidateModelResolutionCaches(tenantId);

      log.info('Tenant LLM policy updated', { tenantId, fields: Object.keys(data), requestId });
      writeAuditLog({
        action: 'tenant-llm-policy:update',
        tenantId,
        userId,
        metadata: { fields: Object.keys(data), requestId },
      });

      res.json({
        success: true,
        policy: {
          credentialPolicy: updated.credentialPolicy,
          allowedProviders: updated.allowedProviders,
          allowProjectCredentials: updated.allowProjectCredentials,
          platformDemoEnabled: updated.platformDemoEnabled,
          monthlyTokenBudget: updated.monthlyTokenBudget,
          dailyTokenBudget: updated.dailyTokenBudget,
          maxRequestsPerMinute: updated.maxRequestsPerMinute,
          defaultModel: updated.defaultModel,
          defaultFastModel: updated.defaultFastModel,
          defaultVoiceModel: updated.defaultVoiceModel,
        },
      });
    } catch (error: any) {
      log.error('Failed to update LLM policy', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to update LLM policy' });
    }
  },
);

export default openapi.router;
