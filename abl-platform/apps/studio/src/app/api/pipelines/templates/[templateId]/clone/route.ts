/**
 * POST /api/pipelines/templates/:templateId/clone
 *
 * Clone a pipeline template into the user's project. Stamps tenantId,
 * projectId, createdBy, and a fresh UUID before saving.
 *
 * Body: { projectId: string, name?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'node:crypto';
import { requireTenantAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { handleApiError, errorJson, ErrorCode } from '@/lib/api-response';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { PipelineDefinitionModel } from '@agent-platform/pipeline-engine/schemas';
import {
  validateGraphPipeline,
  validateNodeModels,
} from '@agent-platform/pipeline-engine/validation';
import { getTemplate } from '@agent-platform/pipeline-engine/templates';
import { getNodeRegistry } from '../../../_shared/registry';
import {
  contractRegistry,
  stampTemplateContractVersions,
} from '../../../_shared/stamp-template-contract-versions';
import {
  generateUniquePipelineName,
  normalizePipelineName,
  isPipelineNameDuplicateKeyError,
} from '@/lib/assert-unique-pipeline-name';

const CloneBodySchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ templateId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { templateId } = await params;

  let body: z.infer<typeof CloneBodySchema>;
  try {
    const raw = await request.json();
    body = CloneBodySchema.parse(raw);
  } catch {
    return errorJson('Invalid body — requires projectId', 400, ErrorCode.VALIDATION_ERROR);
  }

  try {
    const access = await requireProjectAccess(body.projectId, user);
    if (isAccessError(access)) return access;

    const template = await getTemplate(templateId);
    if (!template) {
      return errorJson('Template not found', 404, ErrorCode.NOT_FOUND);
    }

    const now = new Date();
    const pipelineId = crypto.randomUUID();

    // Validate graph structure + contracts (same as POST /api/pipelines)
    const registry = await getNodeRegistry();
    const stampedNodes = stampTemplateContractVersions(
      template.nodes as Array<Record<string, unknown>>,
    );
    if (stampedNodes.length > 0) {
      const definition = {
        ...template,
        _id: pipelineId,
        tenantId: user.tenantId,
        projectId: body.projectId,
        nodes: stampedNodes,
      };
      const graphResult = validateGraphPipeline(definition as any, registry, contractRegistry);
      if (graphResult.errors.length > 0) {
        return NextResponse.json(
          { error: 'Template validation failed', details: graphResult.errors },
          { status: 400 },
        );
      }
      const modelErrors = await validateNodeModels(definition as any, user.tenantId);
      if (modelErrors.length > 0) {
        return NextResponse.json(
          { error: 'Template model validation failed', details: modelErrors },
          { status: 400 },
        );
      }
    }

    // Auto-suffix the cloned name so repeated template clones don't collide with
    // built-in or existing custom pipeline names. Normalize whitespace first.
    const requestedName = normalizePipelineName(body.name ?? template.name);
    const cloneName = await generateUniquePipelineName(
      requestedName,
      user.tenantId,
      body.projectId,
    );

    const pipeline = new PipelineDefinitionModel({
      _id: pipelineId,
      tenantId: user.tenantId,
      projectId: body.projectId,
      name: cloneName,
      description: template.description,
      version: 1,
      status: 'draft',
      supportedTriggers: template.supportedTriggers,
      defaultTriggerIds: template.defaultTriggerIds,
      nodes: stampedNodes,
      entryNodeId: template.entryNodeId || undefined,
      configSchema: template.configSchema,
      createdBy: formatUserLabel(user),
      createdAt: now,
      updatedAt: now,
    });

    await pipeline.save();

    return NextResponse.json(pipeline.toObject(), { status: 201 });
  } catch (error) {
    if (isPipelineNameDuplicateKeyError(error)) {
      return NextResponse.json(
        {
          error: `Pipeline name is already in use; please retry the clone.`,
          code: 'PIPELINE_NAME_TAKEN',
          collidesWith: 'custom',
        },
        { status: 409 },
      );
    }
    return handleApiError(error, 'Template clone POST');
  }
}
