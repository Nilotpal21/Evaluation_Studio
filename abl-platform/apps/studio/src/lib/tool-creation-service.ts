/**
 * Shared Tool Creation Service
 *
 * Extracts the tool creation/update validation pipeline from the tool API routes
 * into a reusable service. Enforces all 9 route invariants:
 *   1. Sandbox feature gate
 *   2. SSRF validation (with templateUrlsAllowed for onboarding)
 *   3. Name uniqueness
 *   4. Max 500 tools per project
 *   5. DSL serialization + source hash
 *   6. Default variable namespace assignment
 *   7. Audit logging
 *   8. Lambda deployment trigger (sandbox)
 *   9. Source hash computation
 *
 * Used by: tools_ops (in-project CRUD), CREATE-time tool persistence (onboarding).
 * NOT used by: the existing tool API routes (parallel path per D-3).
 *
 * @param createdBy — accepts a plain string (userId or display label).
 *   Callers decide format: tools_ops passes userId, tool routes pass formatUserLabel(user).
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  serializeToolFormToDsl,
  computeSourceHash,
  type ProjectToolFormData,
} from '@agent-platform/shared';
import {
  prepareProjectToolDslForPersistence,
  type ProjectToolType,
} from '@agent-platform/shared/tools';
import {
  createProjectTool,
  deleteProjectTool,
  findProjectToolByName,
  countProjectToolsByProject,
  updateProjectTool,
} from '@agent-platform/shared/repos';
import { validateUrlWithPlaceholders } from '@/lib/resolve-and-validate-url';
import { isCodeToolsEnabled } from '@/lib/feature-gates';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { refreshProjectAgentDraftMetadataForToolMutation } from '@/lib/project-tool-draft-invalidation';
import { validateProjectToolBindingsForSave } from '@/lib/project-tool-binding-validation';
import {
  generateToolTestEndpointCapabilities,
  upsertToolTestEndpoint,
  type JsonValue,
} from '@/lib/tool-test-endpoint-service';

const log = createLogger('tool-creation-service');

// ─── Error Class ────────────────────────────────────────────────────────

export class ToolServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ToolServiceError';
  }
}

// ─── Types ──────────────────────────────────────────────────────────────

export interface CreateToolInput {
  tenantId: string;
  projectId: string;
  formData: ProjectToolFormData;
  createdBy: string;
  /** Allow {{env.X}} template URLs that can't be resolved yet (onboarding) */
  templateUrlsAllowed?: boolean;
}

export interface UpdateToolInput {
  tenantId: string;
  projectId: string;
  toolId: string;
  formData: ProjectToolFormData;
  updatedBy: string;
  /** Allow {{env.X}} template URLs that can't be resolved yet */
  templateUrlsAllowed?: boolean;
}

export interface CreateToolFromDslInput {
  tenantId: string;
  projectId: string;
  toolName: string;
  dslContent: string;
  createdBy: string;
  templateUrlsAllowed?: boolean;
}

export interface BootstrapHttpToolContract {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
    enumValues?: string[];
    defaultValue?: string;
    objectSchema?: string;
  }>;
  returnType: string;
}

export interface UpsertBootstrapHttpToolInput {
  tenantId: string;
  projectId: string;
  contract: BootstrapHttpToolContract;
  staticResponse: JsonValue;
  sampleInput?: Record<string, unknown> | null;
  actorId: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Infer tool type from raw DSL content patterns.
 * Falls back to 'sandbox' when no explicit or binding-specific indicators are found.
 */
export function inferToolTypeFromDsl(dsl: string): ProjectToolType {
  if (/\btype:\s*workflow\b/i.test(dsl) || /\bworkflow_id:/i.test(dsl)) return 'workflow';
  if (/\btype:\s*searchai\b/i.test(dsl) || /\bindex_id:/i.test(dsl)) return 'searchai';
  if (/\btype:\s*http\b/i.test(dsl) || /\bendpoint:/i.test(dsl)) return 'http';
  if (/\btype:\s*mcp\b/i.test(dsl) || /\bserver:/i.test(dsl)) return 'mcp';
  return 'sandbox';
}

/**
 * Get or create the default variable namespace for a project.
 * Uses inline VariableNamespace import — matching pattern at tools/route.ts:118-150.
 * (D-11: getOrCreateDefaultNamespace exists only in apps/runtime/ and is not importable here.)
 */
async function getDefaultNamespace(
  tenantId: string,
  projectId: string,
  createdBy: string,
): Promise<string[]> {
  try {
    const { VariableNamespace } = await import('@agent-platform/database/models');
    let defaultNs = await VariableNamespace.findOne({
      tenantId,
      projectId,
      isDefault: true,
    }).lean();

    if (!defaultNs) {
      defaultNs = (
        await VariableNamespace.create({
          tenantId,
          projectId,
          name: 'default',
          displayName: 'Default',
          description: 'Default variable namespace',
          isDefault: true,
          order: 0,
          createdBy,
        })
      ).toObject();
    }

    return defaultNs ? [String(defaultNs._id)] : [];
  } catch (err: unknown) {
    log.warn('Failed to get/create default namespace (non-fatal)', {
      tenantId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Validate SSRF for an HTTP tool endpoint.
 * When templateUrlsAllowed is true, unresolved {{env.X}} / {{secrets.X}} URL
 * placeholders may be saved; literal unsafe URL prefixes are still blocked.
 */
async function validateSsrf(
  endpoint: string,
  tenantId: string,
  projectId: string,
  templateUrlsAllowed: boolean,
): Promise<void> {
  const ssrf = await validateUrlWithPlaceholders(endpoint, tenantId, projectId, 'dev', {
    allowUnresolvedEnvPlaceholders: templateUrlsAllowed,
  });
  if (!ssrf.safe) {
    throw new ToolServiceError(
      ssrf.reason || 'Endpoint blocked by SSRF protection',
      'SSRF_BLOCKED',
    );
  }
}

/**
 * Trigger Lambda deployment for sandbox tools (async, non-fatal).
 */
function triggerLambdaIfNeeded(tenantId: string, runtime: 'javascript' | 'python'): void {
  if (process.env.SANDBOX_BACKEND !== 'lambda') return;
  import('@/services/lambda-deploy-trigger')
    .then(({ triggerLambdaDeployment }) => triggerLambdaDeployment(tenantId, runtime))
    .catch((err: unknown) => {
      log.warn('Lambda deploy trigger failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

function buildBootstrapHttpFormData(
  contract: BootstrapHttpToolContract,
  endpoint: string,
): ProjectToolFormData {
  const endpointOrigin = new URL(endpoint).origin;

  return {
    name: contract.name,
    toolType: 'http',
    description: contract.description,
    parameters: contract.parameters,
    returnType: contract.returnType,
    endpoint,
    method: 'POST',
    auth: 'none',
    // Runtime/server-side fetches do not automatically send Origin, while some
    // Studio-hosted test API deployments enforce it before reaching Next.js.
    headers: [{ key: 'Origin', value: endpointOrigin }],
  };
}

async function assertProjectToolBindingValid(input: {
  tenantId: string;
  projectId: string;
  toolType: ProjectToolType;
  dslContent: string;
}): Promise<void> {
  const validation = await validateProjectToolBindingsForSave(input);
  if (!validation.valid) {
    throw new ToolServiceError(validation.message, validation.code);
  }
}

// ─── Create Tool (from form data) ───────────────────────────────────────

/**
 * Create a tool from typed form data. Enforces all 9 route invariants.
 */
export async function createToolViaService(input: CreateToolInput) {
  const { tenantId, projectId, formData, createdBy } = input;

  // Invariant 1: Sandbox feature gate
  if (formData.toolType === 'sandbox') {
    const enabled = await isCodeToolsEnabled(tenantId);
    if (!enabled) {
      throw new ToolServiceError(
        'Code tools are not enabled for this workspace',
        'CODE_TOOLS_DISABLED',
      );
    }
  }

  // Invariant 2: SSRF validation for HTTP tools
  if (formData.toolType === 'http' && 'endpoint' in formData && formData.endpoint) {
    await validateSsrf(formData.endpoint, tenantId, projectId, input.templateUrlsAllowed ?? false);
  }

  // Invariant 3: Name uniqueness
  const existing = await findProjectToolByName(tenantId, projectId, formData.name);
  if (existing) {
    throw new ToolServiceError(
      `A tool named "${formData.name}" already exists in this project`,
      'NAME_CONFLICT',
    );
  }

  // Invariant 4: Max 500 tools per project
  const toolCount = await countProjectToolsByProject(tenantId, projectId);
  if (toolCount >= 500) {
    throw new ToolServiceError(
      'Maximum of 500 tools per project reached. Delete unused tools before creating new ones.',
      'MAX_TOOLS_REACHED',
    );
  }

  // Invariant 5+9: DSL serialization + source hash
  const dslContent = serializeToolFormToDsl(formData);
  const sourceHash = computeSourceHash(dslContent);
  await assertProjectToolBindingValid({
    tenantId,
    projectId,
    toolType: formData.toolType,
    dslContent,
  });

  // Invariant 6: Default namespace
  const namespaceIds = await getDefaultNamespace(tenantId, projectId, createdBy);

  // Persist
  const tool = await createProjectTool({
    tenantId,
    projectId,
    name: formData.name,
    slug: formData.name,
    toolType: formData.toolType,
    description: formData.description ?? null,
    dslContent,
    sourceHash,
    variableNamespaceIds: namespaceIds,
    createdBy,
  });
  await refreshProjectAgentDraftMetadataForToolMutation({
    projectId,
    tenantId,
  });

  // Invariant 7: Audit logging
  logAuditEvent({
    userId: createdBy,
    tenantId,
    action: AuditActions.TOOL_CREATED,
    metadata: {
      toolId: tool.id,
      toolName: formData.name,
      toolType: formData.toolType,
      projectId,
    },
  }).catch((err: unknown) => {
    log.warn('Audit log failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Invariant 8: Lambda trigger for sandbox
  // TypeScript narrows formData to SandboxToolFormData here since toolType === 'sandbox'
  if (formData.toolType === 'sandbox') {
    const runtime = formData.runtime === 'python' ? 'python' : 'javascript';
    triggerLambdaIfNeeded(tenantId, runtime);
  }

  return tool;
}

// ─── Create Tool (from raw DSL) ─────────────────────────────────────────

/**
 * Create a tool from raw DSL content (e.g., onboarding toolDsls).
 * Parses DSL to infer toolType. If parseable, delegates to createToolViaService.
 * If not parseable, enforces all invariants inline before direct persistence.
 */
export async function createToolFromDsl(input: CreateToolFromDslInput) {
  const { parseDslToToolForm } = await import('@agent-platform/shared/tools');

  const toolType = inferToolTypeFromDsl(input.dslContent);
  const formData =
    toolType === 'http' || toolType === 'mcp' || toolType === 'sandbox'
      ? parseDslToToolForm(input.dslContent, toolType)
      : null;

  if (formData) {
    // DSL is parseable — delegate to full service
    return createToolViaService({
      tenantId: input.tenantId,
      projectId: input.projectId,
      formData: { ...formData, name: input.toolName },
      createdBy: input.createdBy,
      templateUrlsAllowed: input.templateUrlsAllowed,
    });
  }

  // ─── Fallback: unparseable DSL — enforce ALL invariants inline ─────

  const { tenantId, projectId, toolName, dslContent, createdBy } = input;

  // Invariant 1: Sandbox feature gate
  if (toolType === 'sandbox') {
    const enabled = await isCodeToolsEnabled(tenantId);
    if (!enabled) {
      throw new ToolServiceError(
        'Code tools are not enabled for this workspace',
        'CODE_TOOLS_DISABLED',
      );
    }
  }

  // Invariant 2: SSRF — best-effort regex endpoint extraction from raw DSL
  const endpointMatch = dslContent.match(/endpoint:\s*"?([^\n"]+)"?/);
  if (toolType === 'http' && endpointMatch) {
    const endpoint = endpointMatch[1].trim();
    await validateSsrf(endpoint, tenantId, projectId, input.templateUrlsAllowed ?? false);
  }

  // Invariant 3: Name uniqueness
  const existing = await findProjectToolByName(tenantId, projectId, toolName);
  if (existing) {
    throw new ToolServiceError(
      `A tool named "${toolName}" already exists in this project`,
      'NAME_CONFLICT',
    );
  }

  // Invariant 4: Max 500 tools/project
  const toolCount = await countProjectToolsByProject(tenantId, projectId);
  if (toolCount >= 500) {
    throw new ToolServiceError('Maximum of 500 tools per project reached', 'MAX_TOOLS_REACHED');
  }

  const prepared = prepareProjectToolDslForPersistence({
    tenantId,
    projectId,
    name: toolName,
    toolType,
    dslContent,
  });
  if (!prepared.valid) {
    throw new ToolServiceError(prepared.message, 'INVALID_TOOL_DSL');
  }
  await assertProjectToolBindingValid({
    tenantId,
    projectId,
    toolType,
    dslContent: prepared.dslContent,
  });

  // Invariant 6: Default namespace
  const namespaceIds = await getDefaultNamespace(tenantId, projectId, createdBy);

  // Persist
  const tool = await createProjectTool({
    tenantId,
    projectId,
    name: toolName,
    slug: toolName,
    toolType,
    description: null,
    dslContent: prepared.dslContent,
    sourceHash: prepared.sourceHash,
    variableNamespaceIds: namespaceIds,
    createdBy,
  });
  await refreshProjectAgentDraftMetadataForToolMutation({
    projectId,
    tenantId,
  });

  // Invariant 7: Audit logging
  logAuditEvent({
    userId: createdBy,
    tenantId,
    action: AuditActions.TOOL_CREATED,
    metadata: { toolId: tool.id, toolName, toolType, projectId },
  }).catch((err: unknown) => {
    log.warn('Audit log failed in fallback path (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Invariant 8: Lambda trigger for sandbox
  if (toolType === 'sandbox') {
    triggerLambdaIfNeeded(tenantId, 'javascript');
  }

  return tool;
}

// ─── Upsert Bootstrap HTTP Tool ─────────────────────────────────────────

/**
 * Create or update an onboarding bootstrap HTTP tool and its Studio Test API
 * companion endpoint in one idempotent service call.
 */
export async function upsertBootstrapHttpTool(input: UpsertBootstrapHttpToolInput) {
  const { tenantId, projectId, contract, staticResponse, sampleInput, actorId } = input;
  const existing = await findProjectToolByName(tenantId, projectId, contract.name);

  if (existing) {
    const endpointResult = await upsertToolTestEndpoint({
      tenantId,
      projectId,
      projectToolId: existing.id,
      toolName: contract.name,
      staticResponse,
      sampleInput,
      createdBy: existing.createdBy ?? actorId,
      lastEditedBy: actorId,
    });

    const formData = buildBootstrapHttpFormData(contract, endpointResult.urls.invokeUrl);
    const dslContent = serializeToolFormToDsl(formData);
    const sourceHash = computeSourceHash(dslContent);

    const tool = await updateProjectTool(existing.id, tenantId, projectId, {
      description: formData.description ?? null,
      dslContent,
      sourceHash,
      lastEditedBy: actorId,
    });

    if (!tool) {
      throw new Error(`Failed to update bootstrap tool "${contract.name}"`);
    }
    await refreshProjectAgentDraftMetadataForToolMutation({
      projectId,
      tenantId,
    });

    return {
      tool,
      endpoint: endpointResult.endpoint,
      urls: endpointResult.urls,
      created: false,
    };
  }

  const capabilityDraft = generateToolTestEndpointCapabilities();
  const formData = buildBootstrapHttpFormData(contract, capabilityDraft.urls.invokeUrl);
  const tool = await createToolViaService({
    tenantId,
    projectId,
    formData,
    createdBy: actorId,
  });

  try {
    const endpointResult = await upsertToolTestEndpoint({
      tenantId,
      projectId,
      projectToolId: tool.id,
      toolName: contract.name,
      staticResponse,
      sampleInput,
      createdBy: actorId,
      lastEditedBy: actorId,
      invokeCapability: capabilityDraft.invokeCapability,
      specCapability: capabilityDraft.specCapability,
    });

    return {
      tool,
      endpoint: endpointResult.endpoint,
      urls: endpointResult.urls,
      created: true,
    };
  } catch (err: unknown) {
    try {
      await deleteProjectTool(tool.id, tenantId, projectId);
      await refreshProjectAgentDraftMetadataForToolMutation({
        projectId,
        tenantId,
      });
    } catch (cleanupErr: unknown) {
      log.warn('Failed to clean up bootstrap tool after endpoint upsert failure', {
        toolId: tool.id,
        projectId,
        tenantId,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    throw err;
  }
}

// ─── Update Tool (from form data) ───────────────────────────────────────

/**
 * Update an existing tool. Enforces SSRF, DSL serialization, and audit.
 * Slug is immutable (DB schema enforces via pre-save hook).
 */
export async function updateToolViaService(input: UpdateToolInput) {
  const { tenantId, projectId, toolId, formData, updatedBy } = input;

  // SSRF validation for HTTP tools
  if (formData.toolType === 'http' && 'endpoint' in formData && formData.endpoint) {
    await validateSsrf(formData.endpoint, tenantId, projectId, input.templateUrlsAllowed ?? false);
  }

  // Serialize and hash
  const dslContent = serializeToolFormToDsl(formData);
  const sourceHash = computeSourceHash(dslContent);
  await assertProjectToolBindingValid({
    tenantId,
    projectId,
    toolType: formData.toolType,
    dslContent,
  });

  // Persist — do not change slug (immutable)
  const updated = await updateProjectTool(toolId, tenantId, projectId, {
    dslContent,
    sourceHash,
    description: formData.description ?? null,
    lastEditedBy: updatedBy,
  });
  if (updated) {
    await refreshProjectAgentDraftMetadataForToolMutation({
      projectId,
      tenantId,
    });
  }

  // Audit
  logAuditEvent({
    userId: updatedBy,
    tenantId,
    action: AuditActions.TOOL_UPDATED,
    metadata: { toolId, toolType: formData.toolType, projectId },
  }).catch((err: unknown) => {
    log.warn('Audit log failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Lambda trigger for sandbox type changes
  if (formData.toolType === 'sandbox') {
    const runtime = formData.runtime === 'python' ? 'python' : 'javascript';
    triggerLambdaIfNeeded(tenantId, runtime);
  }

  return updated;
}
