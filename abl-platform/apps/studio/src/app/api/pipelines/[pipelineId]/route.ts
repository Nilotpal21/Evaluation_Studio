/**
 * GET    /api/pipelines/:pipelineId - Get a pipeline definition
 * PATCH  /api/pipelines/:pipelineId - Update a pipeline definition
 * DELETE /api/pipelines/:pipelineId - Soft-delete (archive) a pipeline
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { handleApiError } from '@/lib/api-response';
import { PipelineDefinitionModel } from '@agent-platform/pipeline-engine/schemas';
import {
  validatePipeline,
  validateGraphPipeline,
  validateNodeModels,
} from '@agent-platform/pipeline-engine/validation';
import { ContractRegistry } from '@agent-platform/pipeline-engine/contracts';
import { getNodeRegistry } from '../_shared/registry';
import { resolveTriggerSelections } from '../_shared/resolve-triggers';
import {
  assertUniquePipelineName,
  PipelineNameTakenError,
  normalizePipelineName,
  isPipelineNameDuplicateKeyError,
} from '@/lib/assert-unique-pipeline-name';

const contractRegistry = new ContractRegistry();

function stampContractVersions(def: Record<string, unknown>): Record<string, unknown> {
  const nodes = def.nodes as Array<Record<string, unknown>> | undefined;
  if (!nodes) return def;
  const stampedNodes = nodes.map((n) => {
    const contract = contractRegistry.getNode(n.type as string);
    if (!contract) return n;
    return { ...n, contractVersion: contract.contractVersion };
  });
  return { ...def, nodes: stampedNodes };
}

type RouteParams = { params: Promise<{ pipelineId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { pipelineId } = await params;

  try {
    // Try by _id first, then fall back to pipelineType (for builtin pipelines)
    let pipeline = await PipelineDefinitionModel.findOne({
      _id: pipelineId,
      tenantId: { $in: [user.tenantId, '__platform__'] },
    }).lean();

    if (!pipeline) {
      pipeline = await PipelineDefinitionModel.findOne({
        pipelineType: pipelineId,
        tenantId: { $in: [user.tenantId, '__platform__'] },
        status: 'active',
      }).lean();
    }

    if (!pipeline) {
      return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 });
    }

    return NextResponse.json(pipeline);
  } catch (error) {
    return handleApiError(error, 'Pipeline GET');
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { pipelineId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    // Load existing pipeline with tenant isolation
    const existing = await PipelineDefinitionModel.findOne({
      _id: pipelineId,
      tenantId: user.tenantId,
    });

    if (!existing) {
      return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 });
    }

    // Merge updates into existing document for validation
    let merged = {
      ...existing.toObject(),
      ...body,
      // Don't allow overriding immutable fields
      _id: existing._id,
      tenantId: existing.tenantId,
      createdBy: existing.createdBy,
    };

    const registry = await getNodeRegistry();

    // Resolve trigger selections first so contract-based validation below sees
    // the new triggers (not stale ones from the existing doc).
    const triggerSelections = body.triggerSelections as
      | Array<{ triggerId: string; schedule?: string }>
      | undefined;
    const resolved = await resolveTriggerSelections(triggerSelections);
    if (resolved) {
      merged.supportedTriggers = resolved.supportedTriggers;
      merged.defaultTriggerIds = resolved.defaultTriggerIds;
    }

    // Validate the merged pipeline (linear steps)
    const validationErrors = validatePipeline(merged as any, registry);
    if (validationErrors.length > 0) {
      return NextResponse.json(
        { error: 'Pipeline validation failed', details: validationErrors },
        { status: 400 },
      );
    }

    // If graph nodes are present in the merged result, stamp contractVersion
    // (strict validation for subsequent saves) then validate.
    if (merged.nodes) {
      merged = stampContractVersions(merged) as typeof merged;
      const graphResult = validateGraphPipeline(merged as any, registry, contractRegistry);
      if (graphResult.errors.length > 0) {
        return NextResponse.json(
          { error: 'Graph pipeline validation failed', details: graphResult.errors },
          { status: 400 },
        );
      }
    }

    // Validate model overrides are compatible with the tenant's LLM provider
    const modelErrors = await validateNodeModels(merged as any, user.tenantId);
    if (modelErrors.length > 0) {
      return NextResponse.json(
        { error: 'Model validation failed', details: modelErrors },
        { status: 400 },
      );
    }

    // Clean the incoming name (trim + collapse internal whitespace) before checks and persist.
    // Reject an all-whitespace name explicitly so we never overwrite a valid stored name with "".
    if (typeof body.name === 'string') {
      body.name = normalizePipelineName(body.name);
      if (body.name === '') {
        return NextResponse.json(
          { error: 'Pipeline name cannot be empty or whitespace-only.' },
          { status: 400 },
        );
      }
    }

    // Enforce save-time name uniqueness when the name is being changed.
    // Skip the check if (cleaned) name matches the existing stored name (no-op rename).
    if (typeof body.name === 'string' && body.name !== existing.name) {
      const projectIdForCheck =
        (typeof body.projectId === 'string' && body.projectId) || existing.projectId || '';
      if (body.name && projectIdForCheck) {
        try {
          await assertUniquePipelineName(
            body.name,
            user.tenantId,
            projectIdForCheck,
            existing._id as string,
          );
        } catch (err) {
          if (err instanceof PipelineNameTakenError) {
            return NextResponse.json(
              { error: err.message, code: err.code, collidesWith: err.collidesWith },
              { status: 409 },
            );
          }
          throw err;
        }
      }
    }

    // Apply updates: increment version, set updatedAt
    const updatableFields: Record<string, unknown> = {};
    if (body.name !== undefined) updatableFields.name = body.name;
    if (body.description !== undefined) updatableFields.description = body.description;
    if (body.trigger !== undefined) updatableFields.trigger = body.trigger;
    if (body.inputSchema !== undefined) updatableFields.inputSchema = body.inputSchema;
    if (body.steps !== undefined) updatableFields.steps = body.steps;
    if (body.projectId !== undefined) updatableFields.projectId = body.projectId;
    // Persist the contract-version-stamped nodes from `merged`, not the raw body.
    if (body.nodes !== undefined) updatableFields.nodes = merged.nodes;
    if (body.entryNodeId !== undefined) updatableFields.entryNodeId = body.entryNodeId;
    if (body.onNodeFailure !== undefined) updatableFields.onNodeFailure = body.onNodeFailure;
    // Resolve triggers server-side from triggerSelections only
    if (resolved) {
      updatableFields.supportedTriggers = resolved.supportedTriggers;
      updatableFields.defaultTriggerIds = resolved.defaultTriggerIds;
    }

    // Backfill createdBy: if stored as raw user ID, replace with display name
    if (existing.createdBy === user.id) {
      updatableFields.createdBy = formatUserLabel(user);
    }

    const updated = await PipelineDefinitionModel.findOneAndUpdate(
      { _id: pipelineId, tenantId: user.tenantId },
      {
        $set: updatableFields,
        $inc: { version: 1 },
      },
      { new: true, lean: true },
    );

    // Invalidate the Redis-backed definition cache so Kafka-triggered runs
    // pick up the updated definition immediately.
    const { invalidateDefinitionCache } = await import('@/lib/invalidate-definition-cache');
    await invalidateDefinitionCache();

    return NextResponse.json(updated);
  } catch (error) {
    // Race-window safety net for rename collisions: see POST /api/pipelines.
    if (isPipelineNameDuplicateKeyError(error)) {
      return NextResponse.json(
        {
          error: `Pipeline name "${body.name}" is already in use.`,
          code: 'PIPELINE_NAME_TAKEN',
          collidesWith: 'custom',
        },
        { status: 409 },
      );
    }
    return handleApiError(error, 'Pipeline PATCH');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { pipelineId } = await params;

  try {
    const updated = await PipelineDefinitionModel.findOneAndUpdate(
      { _id: pipelineId, tenantId: user.tenantId },
      { $set: { status: 'archived' } },
      { new: true, lean: true },
    );

    if (!updated) {
      return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'Pipeline DELETE');
  }
}
