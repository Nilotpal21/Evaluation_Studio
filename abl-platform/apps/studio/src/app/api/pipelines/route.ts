/**
 * GET  /api/pipelines - List pipelines for the authenticated tenant
 * POST /api/pipelines - Create a new pipeline definition
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { requireTenantAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { handleApiError } from '@/lib/api-response';
import { PipelineDefinitionModel } from '@agent-platform/pipeline-engine/schemas';
import {
  validatePipeline,
  validateGraphPipeline,
  validateNodeModels,
} from '@agent-platform/pipeline-engine/validation';
import { ContractRegistry } from '@agent-platform/pipeline-engine/contracts';
import { getNodeRegistry } from './_shared/registry';
import { resolveTriggerSelections } from './_shared/resolve-triggers';
import {
  assertUniquePipelineName,
  PipelineNameTakenError,
  normalizePipelineName,
  isPipelineNameDuplicateKeyError,
} from '@/lib/assert-unique-pipeline-name';

// Module-level contract registry — pure static data, safe to share across requests.
const contractRegistry = new ContractRegistry();

/**
 * Stamp every graph node with the highest contractVersion among its contract.
 * Legacy nodes (unknown to the registry) are left unstamped — the validator treats
 * them as "legacy" and downgrades errors to warnings.
 */
function stampContractVersions(body: Record<string, unknown>): Record<string, unknown> {
  const nodes = body.nodes as Array<Record<string, unknown>> | undefined;
  if (!nodes) return body;
  const stampedNodes = nodes.map((n) => {
    const contract = contractRegistry.getNode(n.type as string);
    if (!contract) return n;
    return { ...n, contractVersion: contract.contractVersion };
  });
  return { ...body, nodes: stampedNodes };
}

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  try {
    const { searchParams } = request.nextUrl;
    const projectId = searchParams.get('projectId');
    const status = searchParams.get('status');

    const filter: Record<string, unknown> = { tenantId: user.tenantId };
    if (status) {
      filter.status = status;
    } else {
      // Default: show draft and active pipelines (exclude archived)
      filter.status = { $in: ['draft', 'active'] };
    }
    if (projectId) {
      filter.projectId = projectId;
    }

    const pipelines = await PipelineDefinitionModel.find(filter).sort({ updatedAt: -1 }).lean();

    return NextResponse.json({ pipelines });
  } catch (error) {
    return handleApiError(error, 'Pipelines GET');
  }
}

export async function POST(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const registry = await getNodeRegistry();

  // Resolve trigger selections first so contract-based validation below has the
  // supportedTriggers populated. Resolution is pure registry lookup, no side effects.
  const triggerSelections = body.triggerSelections as
    | Array<{ triggerId: string; schedule?: string }>
    | undefined;
  const resolved = await resolveTriggerSelections(triggerSelections);
  if (resolved) {
    body.supportedTriggers = resolved.supportedTriggers;
    body.defaultTriggerIds = resolved.defaultTriggerIds;
  }

  // Validate pipeline structure (linear steps)
  const validationErrors = validatePipeline(body as any, registry);
  if (validationErrors.length > 0) {
    return NextResponse.json(
      { error: 'Pipeline validation failed', details: validationErrors },
      { status: 400 },
    );
  }

  // If graph nodes are provided, stamp contractVersion then validate.
  // Stamping BEFORE validation ensures new saves are strict (not legacy).
  if (body.nodes) {
    body = stampContractVersions(body);
    const graphResult = validateGraphPipeline(body as any, registry, contractRegistry);
    if (graphResult.errors.length > 0) {
      return NextResponse.json(
        { error: 'Graph pipeline validation failed', details: graphResult.errors },
        { status: 400 },
      );
    }
  }

  // Validate model overrides are compatible with the tenant's LLM provider
  const modelErrors = await validateNodeModels(body as any, user.tenantId);
  if (modelErrors.length > 0) {
    return NextResponse.json(
      { error: 'Model validation failed', details: modelErrors },
      { status: 400 },
    );
  }

  // Trim leading/trailing + collapse internal whitespace so the stored name is canonical.
  // Always overwrite body.name so we never persist a non-canonical value (e.g. "  Name " →
  // "Name", "   " → ""). Reject when the result is empty.
  if (typeof body.name === 'string') {
    body.name = normalizePipelineName(body.name);
    if (body.name === '') {
      return NextResponse.json(
        { error: 'Pipeline name cannot be empty or whitespace-only.' },
        { status: 400 },
      );
    }
  }

  // Enforce save-time name uniqueness across built-in and custom pipelines
  // within the same (tenantId, projectId) scope.
  const proposedProjectId = typeof body.projectId === 'string' ? body.projectId : '';
  if (typeof body.name === 'string' && body.name && proposedProjectId) {
    try {
      await assertUniquePipelineName(body.name, user.tenantId, proposedProjectId);
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

  try {
    const now = new Date();
    const pipeline = new PipelineDefinitionModel({
      _id: crypto.randomUUID(),
      tenantId: user.tenantId,
      projectId: body.projectId || undefined,
      name: body.name,
      description: body.description || undefined,
      version: 1,
      status: 'draft',

      // Legacy format fields
      trigger: body.trigger,
      inputSchema: body.inputSchema || undefined,
      steps: body.steps,
      onStepFailure: body.onStepFailure || undefined,

      // Multi-trigger format fields
      configSchema: body.configSchema || undefined,
      supportedTriggers: resolved?.supportedTriggers || undefined,
      defaultTriggerIds: resolved?.defaultTriggerIds || undefined,
      strategies: body.strategies || undefined,

      // Graph-based pipeline fields
      nodes: body.nodes || undefined,
      entryNodeId: body.entryNodeId || undefined,
      onNodeFailure: body.onNodeFailure || undefined,

      // Metadata
      tags: body.tags || undefined,
      maxConcurrency: body.maxConcurrency || undefined,
      createdBy: formatUserLabel(user),
      createdAt: now,
      updatedAt: now,
    });

    await pipeline.save();

    return NextResponse.json(pipeline.toObject(), { status: 201 });
  } catch (error) {
    // Race-window safety net: another request inserted the same name between
    // assertUniquePipelineName() and save(). The partial unique index on
    // (tenantId, projectId, name) fires E11000 and we map it back to 409.
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
    return handleApiError(error, 'Pipelines POST');
  }
}
