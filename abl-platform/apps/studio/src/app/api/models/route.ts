/**
 * GET  /api/models - List model configurations
 * POST /api/models - Create a new model configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { MODEL_ROUTING_TIERS } from '@agent-platform/shared-kernel/model-routing';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findUserTenantMemberships } from '@/repos/auth-repo';
import { findModelConfigs, createModelConfig } from '@/repos/project-repo';
import { findProjects } from '@/repos/project-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  MODEL_CONFIG_NAME_ERROR_MESSAGE,
  MODEL_CONFIG_NAME_PATTERN,
} from '@/lib/model-config-name-validation';
import { validateModelConfigCredentialRefs } from '@/lib/model-config-credential-validation';
import { normalizeProjectModelTenantBinding } from '@/lib/model-config-tenant-model-normalization';
import { notifyRuntimeModelConfigChanged } from '@/lib/runtime-model-cache-invalidation';

const log = createLogger('models');

// Zod schemas for model configurations
const modelConfigItemSchema = z.object({
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
});

const listModelConfigsResponseSchema = z.object({
  models: z.array(modelConfigItemSchema),
});

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const createModelConfigSchema = z.object({
  projectId: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1, 'Model configuration name is required')
    .max(100, 'Model configuration name must be 100 characters or less')
    .regex(MODEL_CONFIG_NAME_PATTERN, MODEL_CONFIG_NAME_ERROR_MESSAGE),
  modelId: optionalNonEmptyString,
  provider: z.string().min(1),
  credentialId: z.string().optional(),
  authProfileId: z.string().nullable().optional(),
  tenantModelId: optionalNonEmptyString,
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(1000000).default(4096),
  topP: z.number().min(0).max(1).default(1.0),
  frequencyPenalty: z.number().min(-2).max(2).default(0),
  presencePenalty: z.number().min(-2).max(2).default(0),
  hyperParameters: z.record(z.unknown()).nullable().optional(),
  inputCostPer1k: z.number().optional(),
  outputCostPer1k: z.number().optional(),
  supportsTools: z.boolean().default(true),
  supportsVision: z.boolean().default(false),
  supportsStreaming: z.boolean().default(true),
  contextWindow: z.number().int().default(128000),
  useResponsesApi: z.boolean().nullable().optional(),
  useStreaming: z.boolean().nullable().optional(),
  tier: z.enum(MODEL_ROUTING_TIERS).default('balanced'),
  isDefault: z.boolean().default(false),
  priority: z.number().int().default(0),
});

type CreateModelConfigInput = z.infer<typeof createModelConfigSchema>;

async function getHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const projectId = request.nextUrl.searchParams.get('projectId');

  try {
    // Find tenants the user belongs to for access control
    const memberships = await findUserTenantMemberships(user.id);
    const tenantIds = memberships.map((m: any) => m.tenantId);

    const projectAccessFilter: Record<string, unknown> = {
      ...(projectId ? { id: projectId } : {}),
      OR: [
        { ownerId: user.id },
        ...(tenantIds.length > 0 ? [{ tenantId: { in: tenantIds } }] : []),
      ],
    };

    const accessibleProjects = await findProjects(projectAccessFilter);
    const accessibleProjectIds = accessibleProjects.map((project: any) => String(project.id));

    if (accessibleProjectIds.length === 0) {
      return NextResponse.json({ models: [] });
    }

    const scopedProjects = accessibleProjects.map((project: any) => ({
      projectId: String(project.id),
      tenantId: String(project.tenantId),
    }));

    const configs = await findModelConfigs({ scopedProjects });

    return NextResponse.json({ models: configs });
  } catch (error) {
    log.error('List error', { err: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function postHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const body = await request.json();
  const result = createModelConfigSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  const parsedData = result.data;

  try {
    // Verify project access: owner OR tenant member
    const memberships = await findUserTenantMemberships(user.id);
    const tenantIds = memberships.map((m: any) => m.tenantId);

    const projects = await findProjects({
      id: parsedData.projectId,
      OR: [
        { ownerId: user.id },
        ...(tenantIds.length > 0 ? [{ tenantId: { in: tenantIds } }] : []),
      ],
    });

    if (projects.length === 0) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const projectTenantId = String(projects[0].tenantId);
    const normalizedBinding = await normalizeProjectModelTenantBinding<CreateModelConfigInput>({
      data: parsedData,
      tenantId: projectTenantId,
      requireModelIdentity: true,
    });
    if (!normalizedBinding.ok) {
      const { status, ...body } = normalizedBinding.error;
      return NextResponse.json(body, { status });
    }
    const normalizedData = normalizedBinding.data;

    const credentialValidationError = await validateModelConfigCredentialRefs({
      projectId: normalizedData.projectId,
      tenantId: projectTenantId,
      user,
      provider: normalizedData.provider,
      authProfileId: normalizedData.authProfileId,
      credentialId: normalizedData.credentialId,
    });

    if (credentialValidationError) {
      return credentialValidationError;
    }

    const config = await createModelConfig({
      ...normalizedData,
      tenantId: projectTenantId,
    });

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.MODEL_CONFIG_CREATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        modelConfigId: config.id,
        projectId: normalizedData.projectId,
        modelId: normalizedData.modelId,
      },
    });

    await notifyRuntimeModelConfigChanged({
      tenantId: projectTenantId,
      authorization: request.headers.get('authorization'),
    });

    return NextResponse.json(config, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as any).code === 11000) {
      return NextResponse.json(
        { error: 'A model config with this name already exists in the project' },
        { status: 409 },
      );
    }
    log.error('Create error', { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'List model configurations',
    description: "Retrieve all model configurations for the user's projects.",
    response: listModelConfigsResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const POST = withOpenAPI(
  {
    summary: 'Create model configuration',
    description: 'Create a new model configuration for a project with specified parameters.',
    body: createModelConfigSchema,
    response: modelConfigItemSchema,
    successStatus: 201,
    auth: true,
  },
  postHandler as any,
);
