import { createLogger } from '@abl/compiler/platform/logger.js';
import { computeSourceHash, type ProjectToolFormData } from '@agent-platform/shared';
import { parseDslProperties } from '@agent-platform/shared/tools';
import type { PageContext } from '@agent-platform/arch-ai';
import { checkToolPermission, isDangerousAction, type ToolPermissionContext } from '../guards';
import { invalidateProjectCaches } from './cache-invalidation';
import { refreshProjectAgentDraftMetadataForToolMutation } from '@/lib/project-tool-draft-invalidation';
import { validateProjectToolBindingsForSave } from '@/lib/project-tool-binding-validation';
import { getOrCreateDefaultVariableNamespaceIds } from '@/lib/default-variable-namespace';

const log = createLogger('arch-ai:tools-ops');

interface ToolsOpsInput {
  action: 'read' | 'list' | 'create' | 'update' | 'test' | 'delete';
  toolId?: string;
  toolName?: string;
  config?: Record<string, unknown>;
  testInput?: Record<string, unknown>;
  confirmed?: boolean;
}

interface ToolsOpsResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  needsConfirmation?: boolean;
  warning?: string;
}

interface ToolsOpsEnv {
  pageContext?: PageContext | null;
}

function resolveContextToolId(input: ToolsOpsInput, env?: ToolsOpsEnv): string | undefined {
  if (input.toolId) {
    return input.toolId;
  }

  const entity = env?.pageContext?.entity;
  if (entity?.type === 'tool' && entity.id) {
    return entity.id;
  }

  return undefined;
}

export async function executeToolsOps(
  input: ToolsOpsInput,
  ctx: ToolPermissionContext,
  env?: ToolsOpsEnv,
): Promise<ToolsOpsResult> {
  const { action } = input;
  const { projectId, user } = ctx;
  const tenantId = user.tenantId;
  const resolvedToolId = resolveContextToolId(input, env);

  const perm = await checkToolPermission('tools_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  if (isDangerousAction('tools_ops', action) && !input.confirmed) {
    return {
      needsConfirmation: true,
      warning: `Delete tool "${input.toolName ?? resolvedToolId ?? 'this tool'}"? Agents using it will break.`,
    };
  }

  const missing = (param: string) => ({
    success: false as const,
    error: { code: 'MISSING_PARAM', message: `${param} is required for ${action}` },
  });

  switch (action) {
    case 'list':
      return listTools(projectId, tenantId);
    case 'read':
      if (!resolvedToolId) return missing('toolId');
      return readTool(projectId, resolvedToolId, tenantId);
    case 'create':
      if (!input.toolName || !input.config) return missing('toolName and config');
      return createTool(projectId, input.toolName, input.config, ctx, env);
    case 'update':
      if (!resolvedToolId || !input.config) return missing('toolId and config');
      return updateTool(projectId, resolvedToolId, input.config, ctx, env);
    case 'test':
      if (!resolvedToolId) return missing('toolId');
      return testTool(projectId, resolvedToolId, input.testInput, ctx);
    case 'delete':
      if (!resolvedToolId) return missing('toolId');
      return deleteTool(projectId, resolvedToolId, ctx);
    default:
      return {
        success: false,
        error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
      };
  }
}

async function listTools(projectId: string, tenantId: string): Promise<ToolsOpsResult> {
  const { findProjectToolsByProject } = await import('@agent-platform/shared/repos');
  const result = await findProjectToolsByProject(tenantId, projectId);
  return {
    success: true,
    data: {
      total: result.pagination.total,
      tools: result.data.map((t) => ({
        ...withAgentToolReference({
          id: t.id,
          name: t.name,
          toolType: t.toolType,
          description: t.description ?? null,
          dslContent: t.dslContent,
          variableNamespaceIds: t.variableNamespaceIds ?? [],
        }),
      })),
    },
  };
}

async function readTool(
  projectId: string,
  toolId: string,
  tenantId: string,
): Promise<ToolsOpsResult> {
  const { findProjectToolById } = await import('@agent-platform/shared/repos');
  const tool = await findProjectToolById(toolId, tenantId, projectId);
  if (!tool) {
    return { success: false, error: { code: 'NOT_FOUND', message: `Tool "${toolId}" not found` } };
  }
  return { success: true, data: withAgentToolReference(tool) };
}

async function createTool(
  projectId: string,
  toolName: string,
  config: Record<string, unknown>,
  ctx: ToolPermissionContext,
  env?: ToolsOpsEnv,
): Promise<ToolsOpsResult> {
  try {
    if (isSearchAIToolConfig(config)) {
      const tool = await createSearchAITool(projectId, toolName, config, ctx, env);
      return {
        success: true,
        data: {
          created: true,
          id: tool.id,
          name: tool.name,
          toolType: tool.toolType,
          ...buildAgentToolReference(tool),
          ...buildToolCreationFollowUp(tool),
        },
      };
    }

    const { createToolViaService } = await import('@/lib/tool-creation-service');
    const formData = buildFormDataFromConfig(toolName, config);
    const tool = await createToolViaService({
      tenantId: ctx.user.tenantId,
      projectId,
      formData,
      createdBy: ctx.user.userId,
      templateUrlsAllowed: true,
    });
    const { syncActiveDraftFromTool } = await import('@/lib/arch-ai/integration-draft-service');
    await syncActiveDraftFromTool({
      tenantId: ctx.user.tenantId,
      projectId,
      userId: ctx.user.userId,
      sessionId: ctx.sessionId,
      tool: {
        id: tool.id,
        name: tool.name,
        toolType: tool.toolType,
        dslContent: tool.dslContent,
        variableNamespaceIds: tool.variableNamespaceIds ?? [],
      },
    });
    invalidateProjectCaches(ctx.user.tenantId, projectId);
    log.info('Tool created', { projectId, toolName, tenantId: ctx.user.tenantId });
    return {
      success: true,
      data: {
        created: true,
        id: tool.id,
        name: tool.name,
        toolType: tool.toolType,
        ...buildAgentToolReference(tool),
        ...buildToolCreationFollowUp(tool),
      },
    };
  } catch (err: unknown) {
    const { ToolServiceError } = await import('@/lib/tool-creation-service');
    if (err instanceof ToolServiceError) {
      return { success: false, error: { code: err.code, message: err.message } };
    }
    throw err;
  }
}

async function updateTool(
  projectId: string,
  toolId: string,
  config: Record<string, unknown>,
  ctx: ToolPermissionContext,
  env?: ToolsOpsEnv,
): Promise<ToolsOpsResult> {
  try {
    const { findProjectToolById } = await import('@agent-platform/shared/repos');
    const existing = await findProjectToolById(toolId, ctx.user.tenantId, projectId);
    if (!existing) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Tool "${toolId}" not found` },
      };
    }

    if (isSearchAIToolConfig(config)) {
      if (existing.toolType !== 'searchai') {
        return {
          success: false,
          error: {
            code: 'TOOL_TYPE_MISMATCH',
            message: `Tool "${existing.name}" is ${existing.toolType}; create a new searchai tool instead of changing its type.`,
          },
        };
      }
      const updated = await updateSearchAITool(
        projectId,
        existing.id,
        existing.name,
        config,
        ctx,
        env,
      );
      invalidateProjectCaches(ctx.user.tenantId, projectId);
      log.info('SearchAI tool updated', { projectId, toolId, tenantId: ctx.user.tenantId });
      return { success: true, data: updated ? withAgentToolReference(updated) : updated };
    }

    const { updateToolViaService } = await import('@/lib/tool-creation-service');
    const formData = buildFormDataFromConfig(existing.name, config);
    const updated = await updateToolViaService({
      tenantId: ctx.user.tenantId,
      projectId,
      toolId,
      formData,
      updatedBy: ctx.user.userId,
      templateUrlsAllowed: true,
    });
    if (updated) {
      const { syncActiveDraftFromTool } = await import('@/lib/arch-ai/integration-draft-service');
      await syncActiveDraftFromTool({
        tenantId: ctx.user.tenantId,
        projectId,
        userId: ctx.user.userId,
        sessionId: ctx.sessionId,
        tool: {
          id: updated.id,
          name: updated.name,
          toolType: updated.toolType,
          dslContent: updated.dslContent,
          variableNamespaceIds: updated.variableNamespaceIds ?? [],
        },
      });
    }
    invalidateProjectCaches(ctx.user.tenantId, projectId);
    log.info('Tool updated', { projectId, toolId, tenantId: ctx.user.tenantId });
    return { success: true, data: updated ? withAgentToolReference(updated) : updated };
  } catch (err: unknown) {
    const { ToolServiceError } = await import('@/lib/tool-creation-service');
    if (err instanceof ToolServiceError) {
      return { success: false, error: { code: err.code, message: err.message } };
    }
    throw err;
  }
}

async function testTool(
  projectId: string,
  toolId: string,
  testInput: Record<string, unknown> | undefined,
  ctx: ToolPermissionContext,
): Promise<ToolsOpsResult> {
  const { findProjectToolById } = await import('@agent-platform/shared/repos');
  const tool = await findProjectToolById(toolId, ctx.user.tenantId, projectId);
  if (!tool) {
    return { success: false, error: { code: 'NOT_FOUND', message: `Tool "${toolId}" not found` } };
  }

  const { executeToolTest } = await import('@/services/tool-test-service');
  const result = await executeToolTest({
    toolId,
    tenantId: ctx.user.tenantId,
    userId: ctx.user.userId,
    projectId,
    input: testInput,
  });
  const { syncActiveDraftFromTool } = await import('@/lib/arch-ai/integration-draft-service');
  await syncActiveDraftFromTool({
    tenantId: ctx.user.tenantId,
    projectId,
    userId: ctx.user.userId,
    sessionId: ctx.sessionId,
    tool: {
      id: tool.id,
      name: tool.name,
      toolType: tool.toolType,
      dslContent: tool.dslContent,
      variableNamespaceIds: tool.variableNamespaceIds ?? [],
    },
  });

  return {
    success: true,
    data: {
      output: result.output,
      latencyMs: result.latencyMs,
      logs: result.logs,
      error: result.error,
    },
  };
}

async function deleteTool(
  projectId: string,
  toolId: string,
  ctx: ToolPermissionContext,
): Promise<ToolsOpsResult> {
  const { findProjectToolById, deleteProjectTool } = await import('@agent-platform/shared/repos');
  const tool = await findProjectToolById(toolId, ctx.user.tenantId, projectId);
  if (!tool) {
    return { success: false, error: { code: 'NOT_FOUND', message: `Tool "${toolId}" not found` } };
  }
  await deleteProjectTool(toolId, ctx.user.tenantId, projectId);
  await refreshProjectAgentDraftMetadataForToolMutation({
    projectId,
    tenantId: ctx.user.tenantId,
  });
  const { removeActiveDraftTool } = await import('@/lib/arch-ai/integration-draft-service');
  await removeActiveDraftTool({
    tenantId: ctx.user.tenantId,
    projectId,
    userId: ctx.user.userId,
    sessionId: ctx.sessionId,
    toolId,
  });
  invalidateProjectCaches(ctx.user.tenantId, projectId);
  log.info('Tool deleted', { projectId, toolId, tenantId: ctx.user.tenantId });
  return { success: true, data: { deleted: true, name: tool.name } };
}

// ─── Helper: LLM config → ProjectToolFormData / ProjectTool DSL ─────────

interface ToolRecordForReference {
  id?: string;
  name: string;
  toolType: string;
  description?: string | null;
  dslContent?: string | null;
  variableNamespaceIds?: string[];
}

interface SearchAIToolResolution {
  indexId: string;
  kbName?: string;
}

const SEARCHAI_DEFAULT_PARAMETERS = [
  {
    name: 'query',
    type: 'string',
    required: true,
    description: 'Natural language search query',
  },
  {
    name: 'queryType',
    type: 'string',
    required: false,
    description: 'Search mode: hybrid, semantic, structured, vector, or aggregation',
  },
  {
    name: 'filters',
    type: 'object',
    required: false,
    description: 'Metadata filters as an array or object',
  },
  {
    name: 'limit',
    type: 'number',
    required: false,
    description: 'Maximum number of results to return',
  },
];

function isSearchAIToolConfig(config: Record<string, unknown>): boolean {
  const toolType = config.type ?? config.toolType;
  return toolType === 'searchai';
}

function inlineQuote(value: string): string {
  if (/[\s:#"'{}[\],]/.test(value) || value.length === 0) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildAgentToolReference(tool: ToolRecordForReference): {
  agentToolSignature?: string;
  agentToolBlock?: string;
} {
  const firstLine = tool.dslContent?.split('\n')[0]?.trim();
  if (!firstLine) {
    return {};
  }

  const props = parseDslProperties(tool.dslContent ?? '');
  const description = tool.description ?? props.description;
  const block = [`  ${firstLine}`];
  if (description) {
    block.push(`    description: ${inlineQuote(String(description))}`);
  }

  return {
    agentToolSignature: firstLine,
    agentToolBlock: block.join('\n'),
  };
}

function buildToolCreationFollowUp(tool: ToolRecordForReference): {
  runtimeReadiness: {
    projectToolRecordCreated: true;
    agentSignatureReady: boolean;
    requiresToolTest: true;
  };
  nextActions: string[];
} {
  const reference = buildAgentToolReference(tool);
  return {
    runtimeReadiness: {
      projectToolRecordCreated: true,
      agentSignatureReady: Boolean(reference.agentToolBlock),
      requiresToolTest: true,
    },
    nextActions: [
      `Run tools_ops(action: "test", toolId: "${tool.id}") with representative input before linking this tool to production traffic.`,
      reference.agentToolBlock
        ? 'Use agentToolBlock from this result in a propose_modification TOOLS section edit; do not paste endpoint/auth/body implementation fields into the agent DSL.'
        : 'Read the tool again and derive an agent TOOLS signature before linking it to an agent.',
      'After linking the signature to an agent, run health_check or diagnose_project with focus="tools" to verify no unresolved tool diagnostics were introduced.',
    ],
  };
}

function withAgentToolReference<T extends ToolRecordForReference>(tool: T): T {
  return {
    ...tool,
    ...buildAgentToolReference(tool),
  };
}

function normalizeSearchAIParameters(config: Record<string, unknown>) {
  const params = Array.isArray(config.parameters)
    ? (config.parameters as Array<Record<string, unknown>>)
    : SEARCHAI_DEFAULT_PARAMETERS;

  return params.map((param) => ({
    name: stringValue(param.name) ?? 'query',
    type: stringValue(param.type) ?? 'string',
    required: typeof param.required === 'boolean' ? param.required : true,
    description: stringValue(param.description),
  }));
}

function buildSearchAIToolDsl(params: {
  toolName: string;
  config: Record<string, unknown>;
  resolution: SearchAIToolResolution;
  tenantId: string;
}): string {
  const parameters = normalizeSearchAIParameters(params.config)
    .map((param) => `${param.name}${param.required ? '' : '?'}: ${param.type}`)
    .join(', ');
  const returnType = stringValue(params.config.returnType) ?? 'object';
  const description =
    stringValue(params.config.description) ??
    `Search ${params.resolution.kbName ?? 'knowledge base'}`;

  const lines = [
    `${params.toolName}(${parameters}) -> ${returnType}`,
    `  description: ${inlineQuote(description)}`,
    '  type: searchai',
    `  index_id: ${inlineQuote(params.resolution.indexId)}`,
    `  tenant_id: ${inlineQuote(params.tenantId)}`,
  ];

  if (params.resolution.kbName) {
    lines.push(`  kb_name: ${inlineQuote(params.resolution.kbName)}`);
  }

  const richParams = normalizeSearchAIParameters(params.config).filter(
    (param) => param.description,
  );
  if (richParams.length > 0) {
    lines.push('  params:');
    for (const param of richParams) {
      lines.push(`    ${param.name}:`);
      lines.push(`      description: ${inlineQuote(param.description!)}`);
    }
  }

  return lines.join('\n');
}

async function assertSearchAIToolBindingValid(
  tenantId: string,
  projectId: string,
  dslContent: string,
): Promise<void> {
  const validation = await validateProjectToolBindingsForSave({
    tenantId,
    projectId,
    toolType: 'searchai',
    dslContent,
  });
  if (!validation.valid) {
    const { ToolServiceError } = await import('@/lib/tool-creation-service');
    throw new ToolServiceError(validation.message, validation.code);
  }
}

async function resolveSearchAIResolution(
  config: Record<string, unknown>,
  ctx: ToolPermissionContext,
  env?: ToolsOpsEnv,
): Promise<SearchAIToolResolution> {
  const explicitIndexId =
    stringValue(config.indexId) ??
    stringValue(config.index_id) ??
    stringValue(config.searchIndexId);
  const explicitKbName = stringValue(config.kbName) ?? stringValue(config.kb_name);
  if (explicitIndexId) {
    return { indexId: explicitIndexId, kbName: explicitKbName };
  }

  const kbId = stringValue(config.kbId) ?? stringValue(config.knowledgeBaseId);
  const kbName = explicitKbName;
  if (!kbId && !kbName) {
    throw new Error('indexId, kbId, or kbName is required for searchai tools');
  }
  if (!ctx.authToken) {
    throw new Error('authToken is required to resolve a knowledge base into a searchai tool');
  }

  const { createKBApiClient } = await import('./kb-api-client');
  const { resolveKBContext } = await import('./kb-context');
  const client = createKBApiClient({
    authToken: ctx.authToken,
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
  });
  const resolved = await resolveKBContext(
    { kbId, kbName },
    {
      pageContext: env?.pageContext,
      projectId: ctx.projectId,
      authToken: ctx.authToken,
      tenantId: ctx.user.tenantId,
      userId: ctx.user.userId,
    },
  );
  if (!resolved.kbId) {
    throw new Error('Knowledge base could not be resolved for searchai tool creation');
  }

  const data = await client.get<{ knowledgeBase: Record<string, unknown> }>(
    `/api/search-ai/knowledge-bases/${resolved.kbId}`,
  );
  const knowledgeBase = data.knowledgeBase;
  const indexId = stringValue(knowledgeBase.searchIndexId);
  if (!indexId) {
    throw new Error('Knowledge base has no searchIndexId yet');
  }

  return {
    indexId,
    kbName: stringValue(knowledgeBase.name) ?? kbName,
  };
}

async function createSearchAITool(
  projectId: string,
  toolName: string,
  config: Record<string, unknown>,
  ctx: ToolPermissionContext,
  env?: ToolsOpsEnv,
) {
  const { createProjectTool, findProjectToolByName, countProjectToolsByProject } =
    await import('@agent-platform/shared/repos');
  const existing = await findProjectToolByName(ctx.user.tenantId, projectId, toolName);
  if (existing) {
    throw new Error(`A tool named "${toolName}" already exists in this project`);
  }

  const toolCount = await countProjectToolsByProject(ctx.user.tenantId, projectId);
  if (toolCount >= 500) {
    throw new Error('Maximum of 500 tools per project reached');
  }

  const resolution = await resolveSearchAIResolution(config, ctx, env);
  const dslContent = buildSearchAIToolDsl({
    toolName,
    config,
    resolution,
    tenantId: ctx.user.tenantId,
  });
  await assertSearchAIToolBindingValid(ctx.user.tenantId, projectId, dslContent);
  const description =
    stringValue(config.description) ?? `Search ${resolution.kbName ?? 'knowledge base'}`;
  const variableNamespaceIds = await getOrCreateDefaultVariableNamespaceIds({
    tenantId: ctx.user.tenantId,
    projectId,
    createdBy: ctx.user.userId,
  });

  const tool = await createProjectTool({
    tenantId: ctx.user.tenantId,
    projectId,
    name: toolName,
    slug: toolName,
    toolType: 'searchai',
    description,
    dslContent,
    sourceHash: computeSourceHash(dslContent),
    variableNamespaceIds,
    createdBy: ctx.user.userId,
  });
  await refreshProjectAgentDraftMetadataForToolMutation({
    projectId,
    tenantId: ctx.user.tenantId,
  });

  const { syncActiveDraftFromTool } = await import('@/lib/arch-ai/integration-draft-service');
  await syncActiveDraftFromTool({
    tenantId: ctx.user.tenantId,
    projectId,
    userId: ctx.user.userId,
    sessionId: ctx.sessionId,
    tool: {
      id: tool.id,
      name: tool.name,
      toolType: tool.toolType,
      dslContent: tool.dslContent,
      variableNamespaceIds: tool.variableNamespaceIds ?? [],
    },
  });

  invalidateProjectCaches(ctx.user.tenantId, projectId);
  log.info('SearchAI tool created', { projectId, toolName, tenantId: ctx.user.tenantId });
  return tool;
}

async function updateSearchAITool(
  projectId: string,
  toolId: string,
  toolName: string,
  config: Record<string, unknown>,
  ctx: ToolPermissionContext,
  env?: ToolsOpsEnv,
) {
  const { updateProjectTool } = await import('@agent-platform/shared/repos');
  const resolution = await resolveSearchAIResolution(config, ctx, env);
  const dslContent = buildSearchAIToolDsl({
    toolName,
    config,
    resolution,
    tenantId: ctx.user.tenantId,
  });
  await assertSearchAIToolBindingValid(ctx.user.tenantId, projectId, dslContent);
  const description =
    stringValue(config.description) ?? `Search ${resolution.kbName ?? 'knowledge base'}`;

  const updated = await updateProjectTool(toolId, ctx.user.tenantId, projectId, {
    description,
    dslContent,
    sourceHash: computeSourceHash(dslContent),
    lastEditedBy: ctx.user.userId,
  });

  if (updated) {
    await refreshProjectAgentDraftMetadataForToolMutation({
      projectId,
      tenantId: ctx.user.tenantId,
    });
    const { syncActiveDraftFromTool } = await import('@/lib/arch-ai/integration-draft-service');
    await syncActiveDraftFromTool({
      tenantId: ctx.user.tenantId,
      projectId,
      userId: ctx.user.userId,
      sessionId: ctx.sessionId,
      tool: {
        id: updated.id,
        name: updated.name,
        toolType: updated.toolType,
        dslContent: updated.dslContent,
        variableNamespaceIds: updated.variableNamespaceIds ?? [],
      },
    });
  }

  return updated;
}

/**
 * Generate a mock placeholder endpoint URL from a tool name.
 * Uses an env-var template so the compiler's template-URL check passes
 * (it skips URL validation for strings containing `{{`).
 * The tool name is converted to UPPER_SNAKE for the env var and
 * kebab-case for the path segment.
 */
function generateMockEndpoint(toolName: string, method: string): string {
  const envVar = toolName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const pathSegment = toolName.toLowerCase().replace(/_/g, '-');
  const version = 'v1';
  // POST/PUT/PATCH → base path, GET/DELETE → add /{id} for realism
  const suffix = method === 'GET' || method === 'DELETE' ? '/{id}' : '';
  return `{{env.${envVar}_BASE_URL}}/${version}/${pathSegment}${suffix}`;
}

/**
 * Convert an LLM-provided config object to a typed ProjectToolFormData
 * discriminated union. The LLM sends freeform {type, endpoint, method, ...}
 * and this normalizes it into the shape serializeToolFormToDsl expects.
 *
 * If the LLM omits the endpoint for an HTTP tool, a mock placeholder URL
 * is generated so the tool passes ABL compilation (which rejects empty endpoints).
 */
function buildFormDataFromConfig(
  toolName: string,
  config: Record<string, unknown>,
): ProjectToolFormData {
  const toolType = (config.type as string) ?? (config.toolType as string) ?? 'http';
  const base = {
    name: toolName,
    description: (config.description as string) ?? '',
    parameters: (
      (config.parameters as Array<{
        name: string;
        type: string;
        required: boolean;
        description?: string;
      }>) ?? []
    ).map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required,
      description: p.description ?? '',
    })),
    returnType: (config.returnType as string) ?? 'object',
  };

  switch (toolType) {
    case 'http': {
      const method = ((config.method as string) ?? 'POST') as
        | 'GET'
        | 'POST'
        | 'PUT'
        | 'PATCH'
        | 'DELETE';
      // LLM-generated tools_ops configs frequently pass `url` instead of
      // the canonical `endpoint`. Accept either to avoid silent fallback to a
      // generated mock endpoint (which masks "wrong field name" mistakes).
      const rawEndpointFromAlias =
        (config.endpoint as string | undefined) ?? (config.url as string | undefined) ?? '';
      if (
        rawEndpointFromAlias &&
        rawEndpointFromAlias === (config.url as string | undefined) &&
        config.endpoint === undefined
      ) {
        log.warn('tools_ops create config used "url" alias; canonical field is "endpoint"', {
          toolName,
        });
      }
      const rawEndpoint = rawEndpointFromAlias;
      const endpoint =
        rawEndpoint.trim() !== '' ? rawEndpoint : generateMockEndpoint(toolName, method);
      if (rawEndpoint.trim() === '') {
        log.info('Generated mock endpoint for tool', { toolName, endpoint });
      }
      return {
        ...base,
        toolType: 'http' as const,
        endpoint,
        method,
        auth: ((config.auth as string) ?? 'none') as
          | 'none'
          | 'bearer'
          | 'api_key'
          | 'oauth2_client'
          | 'custom',
        ...(config.authConfig ? { authConfig: config.authConfig as Record<string, string> } : {}),
        ...(config.headers
          ? { headers: config.headers as Array<{ key: string; value: string }> }
          : {}),
        ...(config.timeout ? { timeout: config.timeout as number } : {}),
      };
    }
    case 'sandbox':
      return {
        ...base,
        toolType: 'sandbox' as const,
        runtime: ((config.runtime as string) ?? 'javascript') as 'javascript' | 'python',
        code: (config.code as string) ?? '',
      };
    case 'mcp':
      return {
        ...base,
        toolType: 'mcp' as const,
        server: (config.server as string) ?? '',
        ...(config.serverTool ? { serverTool: config.serverTool as string } : {}),
      };
    default: {
      const fallbackMethod = 'POST' as const;
      return {
        ...base,
        toolType: 'http' as const,
        endpoint: generateMockEndpoint(toolName, fallbackMethod),
        method: fallbackMethod,
        auth: 'none' as const,
      };
    }
  }
}
