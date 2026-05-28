/**
 * GET    /api/models/:id - Get model config details
 * PATCH  /api/models/:id - Update model config
 * DELETE /api/models/:id - Delete model config
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { MODEL_ROUTING_TIERS } from '@agent-platform/shared-kernel/model-routing';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findUserTenantMemberships } from '@/repos/auth-repo';
import {
  findModelConfigByIdAndTenant,
  updateModelConfig,
  deleteModelConfig,
  findProjectByIdAndTenant,
  clearDefaultModelConfigs,
} from '@/repos/project-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { clearStaleJudgeModelRefs } from '@/repos/eval-repo';
import {
  MODEL_CONFIG_NAME_ERROR_MESSAGE,
  MODEL_CONFIG_NAME_PATTERN,
} from '@/lib/model-config-name-validation';
import { validateModelConfigCredentialRefs } from '@/lib/model-config-credential-validation';
import { normalizeProjectModelTenantBinding } from '@/lib/model-config-tenant-model-normalization';
import { notifyRuntimeModelConfigChanged } from '@/lib/runtime-model-cache-invalidation';

type RouteParams = { params: Promise<{ id: string }> };

// Zod schemas for model configurations
const pathParamsSchema = z.object({
  id: z.string(),
});

const modelConfigDetailSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  modelId: z.string(),
  provider: z.string(),
  credentialId: z.string().nullable().optional(),
  authProfileId: z.string().nullable().optional(),
  tenantModelId: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int(),
  topP: z.number().min(0).max(1),
  frequencyPenalty: z.number().min(-2).max(2),
  presencePenalty: z.number().min(-2).max(2),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  inputCostPer1k: z.number().nullable().optional(),
  outputCostPer1k: z.number().nullable().optional(),
  supportsTools: z.boolean(),
  supportsVision: z.boolean(),
  supportsStreaming: z.boolean(),
  contextWindow: z.number().int(),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
  tier: z.enum(MODEL_ROUTING_TIERS),
  isDefault: z.boolean(),
  priority: z.number().int(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  project: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .optional(),
});

const updateModelConfigSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Model configuration name is required')
    .max(100, 'Model configuration name must be 100 characters or less')
    .regex(MODEL_CONFIG_NAME_PATTERN, MODEL_CONFIG_NAME_ERROR_MESSAGE)
    .optional(),
  modelId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  credentialId: z.string().nullable().optional(),
  authProfileId: z.string().nullable().optional(),
  tenantModelId: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1000000).optional(),
  topP: z.number().min(0).max(1).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  inputCostPer1k: z.number().nullable().optional(),
  outputCostPer1k: z.number().nullable().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  contextWindow: z.number().int().optional(),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
  tier: z.enum(MODEL_ROUTING_TIERS).optional(),
  isDefault: z.boolean().optional(),
  priority: z.number().int().optional(),
});

const deleteResponseSchema = z.object({
  success: z.boolean(),
});

/**
 * Check if the user has access to a model config via tenant-scoped lookup or project ownership.
 */
async function checkModelConfigAccess(configId: string, userId: string, tenantId?: string) {
  // Primary path: tenant-scoped lookup
  if (tenantId) {
    const config = await findModelConfigByIdAndTenant(configId, tenantId);
    if (config) {
      const project = await findProjectByIdAndTenant(config.projectId, tenantId);
      if (project) return { config, project };
    }
  }

  // Fallback: check tenant membership
  const memberships = await findUserTenantMemberships(userId);
  const tenantIds = memberships.map((m: any) => m.tenantId);
  for (const tid of tenantIds) {
    const config = await findModelConfigByIdAndTenant(configId, tid);
    if (config) {
      const project = await findProjectByIdAndTenant(config.projectId, tid);
      if (project) return { config, project };
    }
  }

  return null;
}

async function getHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  try {
    const result = await checkModelConfigAccess(id, user.id, user.tenantId);

    if (!result) {
      return NextResponse.json({ error: 'Model config not found' }, { status: 404 });
    }

    return NextResponse.json({
      ...result.config,
      project: { id: result.project.id, name: result.project.name },
    });
  } catch (error) {
    console.error('[Models] Get error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function patchHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const body = await request.json();
  const result = updateModelConfigSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  try {
    const existing = await checkModelConfigAccess(id, user.id, user.tenantId);
    if (!existing) {
      return NextResponse.json({ error: 'Model config not found' }, { status: 404 });
    }

    const hasAuthProfileUpdate = Object.prototype.hasOwnProperty.call(result.data, 'authProfileId');
    const hasCredentialUpdate = Object.prototype.hasOwnProperty.call(result.data, 'credentialId');
    const effectiveAuthProfileId = hasAuthProfileUpdate
      ? result.data.authProfileId
      : existing.config.authProfileId;
    const effectiveCredentialId = hasCredentialUpdate
      ? result.data.credentialId
      : existing.config.credentialId;

    if (hasCredentialUpdate && effectiveCredentialId && effectiveAuthProfileId) {
      return NextResponse.json(
        { error: 'Clear authProfileId before setting credentialId' },
        { status: 400 },
      );
    }

    const normalizedBinding = await normalizeProjectModelTenantBinding({
      data: result.data,
      tenantId: existing.project.tenantId,
      requireModelIdentity: false,
    });
    if (!normalizedBinding.ok) {
      const { status, ...body } = normalizedBinding.error;
      return NextResponse.json(body, { status });
    }
    const updateData = normalizedBinding.data;

    const credentialValidationError = await validateModelConfigCredentialRefs({
      projectId: existing.config.projectId,
      tenantId: existing.project.tenantId,
      user,
      provider: updateData.provider ?? existing.config.provider,
      authProfileId: effectiveAuthProfileId,
      credentialId: effectiveCredentialId,
    });

    if (credentialValidationError) {
      return credentialValidationError;
    }

    // When setting a model as default, unset all other defaults in the same project first
    if (updateData.isDefault) {
      const targetTier = updateData.tier ?? existing.config.tier;
      await clearDefaultModelConfigs(
        existing.config.projectId,
        id,
        targetTier,
        existing.project.tenantId,
      );
    }

    const config = await updateModelConfig(id, updateData, existing.project.tenantId);

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.MODEL_CONFIG_UPDATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { modelConfigId: id, changes: Object.keys(updateData) },
    });

    await notifyRuntimeModelConfigChanged({
      tenantId: existing.project.tenantId,
      authorization: request.headers.get('authorization'),
    });

    return NextResponse.json(config);
  } catch (error) {
    console.error('[Models] Update error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function deleteHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  try {
    const existing = await checkModelConfigAccess(id, user.id, user.tenantId);
    if (!existing) {
      return NextResponse.json({ error: 'Model config not found' }, { status: 404 });
    }

    await deleteModelConfig(id, existing.project.tenantId);

    // Clear any evaluator judgeModel refs pointing to this modelId so they no
    // longer fail preflight after the model config is gone.
    await clearStaleJudgeModelRefs(
      existing.project.tenantId,
      existing.config.projectId,
      existing.config.modelId,
    );

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.MODEL_CONFIG_DELETED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { modelConfigId: id, projectId: existing.config.projectId },
    });

    await notifyRuntimeModelConfigChanged({
      tenantId: existing.project.tenantId,
      authorization: request.headers.get('authorization'),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Models] Delete error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Get model configuration details',
    description: 'Retrieve detailed information about a specific model configuration.',
    params: pathParamsSchema,
    response: modelConfigDetailSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const PATCH = withOpenAPI(
  {
    summary: 'Update model configuration',
    description: "Update an existing model configuration's parameters and settings.",
    params: pathParamsSchema,
    body: updateModelConfigSchema,
    response: modelConfigDetailSchema,
    successStatus: 200,
    auth: true,
  },
  patchHandler as any,
);

export const DELETE = withOpenAPI(
  {
    summary: 'Delete model configuration',
    description: 'Remove a model configuration from a project.',
    params: pathParamsSchema,
    response: deleteResponseSchema,
    successStatus: 200,
    auth: true,
  },
  deleteHandler as any,
);
