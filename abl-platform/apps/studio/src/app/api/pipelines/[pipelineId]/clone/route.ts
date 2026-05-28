/**
 * POST /api/pipelines/:pipelineId/clone - Clone a pipeline definition
 *
 * Creates a copy of the pipeline with a new ID, reset version, and 'draft' status.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { handleApiError } from '@/lib/api-response';
import { PipelineDefinitionModel } from '@agent-platform/pipeline-engine/schemas';
import {
  generateUniquePipelineName,
  normalizePipelineName,
  isPipelineNameDuplicateKeyError,
} from '@/lib/assert-unique-pipeline-name';

type RouteParams = { params: Promise<{ pipelineId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { pipelineId } = await params;

  try {
    const original = (await PipelineDefinitionModel.findOne({
      _id: pipelineId,
      tenantId: user.tenantId,
    }).lean()) as any;

    if (!original) {
      return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 });
    }

    // Auto-suffix the clone name so repeated clones don't collide.
    // Normalize first so trailing whitespace on the original doesn't leak into the copy.
    const cloneName = await generateUniquePipelineName(
      normalizePipelineName(`Copy of ${original.name}`),
      original.tenantId,
      original.projectId,
    );

    const now = new Date();
    const clone = new PipelineDefinitionModel({
      _id: crypto.randomUUID(),
      tenantId: original.tenantId,
      projectId: original.projectId,
      name: cloneName,
      description: original.description,
      version: 1,
      status: 'draft',
      trigger: original.trigger,
      inputSchema: original.inputSchema,
      steps: original.steps,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    await clone.save();

    return NextResponse.json(clone.toObject(), { status: 201 });
  } catch (error) {
    // Race-window safety net: another request inserted the same suffix between
    // generateUniquePipelineName() and save().
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
    return handleApiError(error, 'Pipeline Clone');
  }
}
