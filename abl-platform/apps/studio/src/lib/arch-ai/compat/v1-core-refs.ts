/**
 * Compatibility adapters for the v1-style core function refs consumed by the
 * v4 tool registry.
 *
 * This file intentionally stays inside `compat/**`, but it now resolves its
 * handlers from `arch-ai` local builders instead of reaching back into the
 * legacy `arch-ai` tree.
 */

import type { V1CoreFunctionRefs } from '@agent-platform/arch-ai/engine';
import type { MinimalTurnContext } from '@agent-platform/arch-ai/tools';
import type { PageContext } from '@agent-platform/arch-ai';

type CoreFunction = (...args: unknown[]) => Promise<unknown>;
type CompatTurnContext = MinimalTurnContext & { services?: Record<string, unknown> };
type CompatWidgetVariant =
  | 'model_comparison'
  | 'constraint_coverage'
  | 'kb_status_card'
  | 'upload_progress_card'
  | 'search_results_card'
  | 'kb_health_card'
  | 'connector_status_card'
  | 'doc_processing_card'
  | 'integration_suggestion_card';
type V4InProjectToolName =
  | 'propose_modification'
  | 'apply_modification'
  | 'auth_ops'
  | 'analyze_constraints'
  | 'configure_model'
  | 'diagnose_project'
  | 'dismiss_proposal'
  | 'explain_diagnostic'
  | 'health_check'
  | 'kb_connector'
  | 'kb_documents'
  | 'kb_health'
  | 'kb_ingest'
  | 'kb_manage'
  | 'kb_search'
  | 'manage_memory'
  | 'mcp_server_ops'
  | 'platform_context'
  | 'project_config'
  | 'session_ops'
  | 'trace_diagnosis'
  | 'query_traces'
  | 'read_agent'
  | 'read_insights'
  | 'read_journal'
  | 'read_topology'
  | 'recommend_model'
  | 'testing_ops'
  | 'tools_ops'
  | 'variable_ops'
  | 'integration_ops'
  | 'validate_agent';

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asObjectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCompatPermissions(ctx: CompatTurnContext): string[] | undefined {
  const raw = ctx.services?.permissions;
  if (!Array.isArray(raw)) {
    return undefined;
  }

  return raw.filter((value): value is string => typeof value === 'string');
}

function getCompatAuthToken(ctx: CompatTurnContext): string | undefined {
  const raw = ctx.services?.authToken;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function getCompatPageContext(ctx: CompatTurnContext): PageContext | null | undefined {
  const raw = ctx.services?.pageContext;
  return raw && typeof raw === 'object' ? (raw as PageContext) : undefined;
}

function getCompatAuthContext(ctx: CompatTurnContext): { tenantId: string; userId: string } {
  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  };
}

function resolveCompatProjectId(
  ctx: CompatTurnContext,
  explicitProjectId?: unknown,
): string | null {
  return asNonEmptyString(explicitProjectId) ?? asNonEmptyString(ctx.projectId);
}

function resolveCompatSessionId(
  ctx: CompatTurnContext,
  explicitSessionId?: unknown,
): string | null {
  return asNonEmptyString(explicitSessionId) ?? asNonEmptyString(ctx.sessionId);
}

function unsupportedCompatTool(toolName: string): Promise<unknown> {
  return Promise.resolve({
    success: false,
    error: {
      code: 'V4_COMPAT_TOOL_UNAVAILABLE',
      message: `Compat tool '${toolName}' is not wired in arch-ai.`,
    },
  });
}

function missingCompatScope(toolName: string, missing: 'project' | 'session'): Promise<unknown> {
  return Promise.resolve({
    success: false,
    error: {
      code: missing === 'project' ? 'PROJECT_REQUIRED' : 'SESSION_REQUIRED',
      message: `${toolName} requires a ${missing}-bound arch-ai turn context.`,
    },
  });
}

function missingCompatSession(toolName: string, sessionId: string): Promise<unknown> {
  return Promise.resolve({
    success: false,
    error: {
      code: 'SESSION_NOT_FOUND',
      message: `${toolName} could not load arch-ai session '${sessionId}'.`,
    },
  });
}

type ExecutableCompatTool = {
  execute?: (input: Record<string, unknown>) => Promise<unknown>;
};

function resolveToolExecute(
  toolset: Record<string, unknown>,
  toolName: string,
): ((input: Record<string, unknown>) => Promise<unknown>) | null {
  const tool = toolset[toolName] as ExecutableCompatTool | undefined;
  return typeof tool?.execute === 'function' ? tool.execute.bind(tool) : null;
}

async function loadCompatSession(params: {
  ctx: CompatTurnContext;
  toolName: string;
  explicitSessionId?: unknown;
}): Promise<
  | {
      authCtx: { tenantId: string; userId: string };
      sessionId: string;
      session: unknown;
    }
  | { error: unknown }
> {
  const { ctx, toolName, explicitSessionId } = params;
  const sessionId = resolveCompatSessionId(ctx, explicitSessionId);
  if (!sessionId) {
    return { error: await missingCompatScope(toolName, 'session') };
  }

  const authCtx = getCompatAuthContext(ctx);
  const { sessionService } = await import('@/lib/arch-ai/message-services');
  const session = await sessionService.getById(authCtx, sessionId);
  if (!session) {
    return { error: await missingCompatSession(toolName, sessionId) };
  }

  return { authCtx, sessionId, session };
}

async function executeCompatInterviewTool(params: {
  ctx: CompatTurnContext;
  toolName: 'update_specification' | 'proceed_to_next_phase';
  input: Record<string, unknown>;
  explicitSessionId?: unknown;
}): Promise<unknown> {
  const loaded = await loadCompatSession({
    ctx: params.ctx,
    toolName: params.toolName,
    explicitSessionId: params.explicitSessionId,
  });
  if ('error' in loaded) {
    return loaded.error;
  }

  const { buildInterviewTools } = await import('@/lib/arch-ai/tools/interview-tools');
  const toolset = buildInterviewTools(
    loaded.authCtx,
    loaded.sessionId,
    loaded.session as Parameters<typeof buildInterviewTools>[2],
    undefined,
    getCompatAuthToken(params.ctx),
    { includeCollectFile: false },
  ) as Record<string, unknown>;

  const execute = resolveToolExecute(toolset, params.toolName);
  return execute ? execute(params.input) : unsupportedCompatTool(params.toolName);
}

async function executeCompatBlueprintTool(params: {
  ctx: CompatTurnContext;
  toolName: 'generate_topology' | 'proceed_to_next_phase';
  input: Record<string, unknown>;
  explicitSessionId?: unknown;
}): Promise<unknown> {
  const loaded = await loadCompatSession({
    ctx: params.ctx,
    toolName: params.toolName,
    explicitSessionId: params.explicitSessionId,
  });
  if ('error' in loaded) {
    return loaded.error;
  }

  const { buildBlueprintTools } = await import('@/lib/arch-ai/tools/blueprint-tools');
  const toolset = buildBlueprintTools(
    loaded.authCtx,
    loaded.sessionId,
    loaded.session as Parameters<typeof buildBlueprintTools>[2],
    undefined,
    getCompatAuthToken(params.ctx),
    { includeCollectFile: false },
  ) as Record<string, unknown>;

  const execute = resolveToolExecute(toolset, params.toolName);
  return execute ? execute(params.input) : unsupportedCompatTool(params.toolName);
}

async function executeCompatBuildTool(params: {
  ctx: CompatTurnContext;
  toolName: 'generate_agent' | 'compile_abl' | 'save_tool_dsl' | 'proceed_to_next_phase';
  input: Record<string, unknown>;
  explicitSessionId?: unknown;
  buildSubPhase?: 'TOOLS';
}): Promise<unknown> {
  const sessionId = resolveCompatSessionId(params.ctx, params.explicitSessionId);
  if (!sessionId) {
    return missingCompatScope(params.toolName, 'session');
  }

  const { buildBuildTools } = await import('@/lib/arch-ai/tools/build-tools');
  const toolset = buildBuildTools(
    getCompatAuthContext(params.ctx),
    sessionId,
    undefined,
    params.buildSubPhase,
    { includeCollectFile: false },
  ) as Record<string, unknown>;

  const execute = resolveToolExecute(toolset, params.toolName);
  return execute ? execute(params.input) : unsupportedCompatTool(params.toolName);
}

async function executeCompatProceedToNextPhase(params: {
  ctx: CompatTurnContext;
  input: Record<string, unknown>;
  explicitSessionId?: unknown;
}): Promise<unknown> {
  const loaded = await loadCompatSession({
    ctx: params.ctx,
    toolName: 'proceed_to_next_phase',
    explicitSessionId: params.explicitSessionId,
  });
  if ('error' in loaded) {
    return loaded.error;
  }

  const sessionPhase = (loaded.session as { metadata?: { phase?: string } } | undefined)?.metadata
    ?.phase;

  if (sessionPhase === 'INTERVIEW') {
    return executeCompatInterviewTool({
      ctx: params.ctx,
      toolName: 'proceed_to_next_phase',
      input: params.input,
      explicitSessionId: loaded.sessionId,
    });
  }

  if (sessionPhase === 'BLUEPRINT') {
    return executeCompatBlueprintTool({
      ctx: params.ctx,
      toolName: 'proceed_to_next_phase',
      input: params.input,
      explicitSessionId: loaded.sessionId,
    });
  }

  return executeCompatBuildTool({
    ctx: params.ctx,
    toolName: 'proceed_to_next_phase',
    input: params.input,
    explicitSessionId: loaded.sessionId,
  });
}

function mapUpdateSpecificationInput(
  input: unknown,
  value?: unknown,
  note?: unknown,
): Record<string, unknown> {
  const raw = asObjectRecord(input);
  if (Object.keys(raw).length > 0) {
    return raw;
  }

  return {
    ...(typeof input === 'string' ? { field: input } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(isRecord(note) ? { note } : {}),
  };
}

function mapProceedToNextPhaseInput(input: unknown): Record<string, unknown> {
  const raw = asObjectRecord(input);
  if (Object.keys(raw).length > 0) {
    return raw;
  }

  return {
    reason: typeof input === 'string' && input.length > 0 ? input : 'Continue to the next phase',
  };
}

function mapGenerateAgentInput(input: unknown, code?: unknown): Record<string, unknown> {
  const raw = asObjectRecord(input);
  if (Object.keys(raw).length > 0) {
    return raw;
  }

  return {
    ...(typeof input === 'string' ? { agentName: input } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

function mapCompileAblInput(input: unknown, agentName?: unknown): Record<string, unknown> {
  const raw = asObjectRecord(input);
  if (Object.keys(raw).length > 0) {
    return raw;
  }

  return {
    ...(typeof input === 'string' ? { code: input } : {}),
    ...(typeof agentName === 'string' ? { agentName } : {}),
  };
}

function mapSaveToolDslInput(input: unknown, dslContent?: unknown): Record<string, unknown> {
  const raw = asObjectRecord(input);
  if (Object.keys(raw).length > 0) {
    return raw;
  }

  return {
    ...(typeof input === 'string' ? { toolName: input } : {}),
    ...(typeof dslContent === 'string' ? { dslContent } : {}),
  };
}

function extractCompatProposal(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  if (
    'proposal' in result &&
    result.proposal &&
    typeof result.proposal === 'object' &&
    !Array.isArray(result.proposal)
  ) {
    return result.proposal as Record<string, unknown>;
  }

  const data = (result as { data?: unknown }).data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nestedProposal = (data as { proposal?: unknown }).proposal;
    if (nestedProposal && typeof nestedProposal === 'object' && !Array.isArray(nestedProposal)) {
      return nestedProposal as Record<string, unknown>;
    }
  }

  return null;
}

function emitCompatWidgetArtifact(
  ctx: CompatTurnContext,
  variant: CompatWidgetVariant,
  payload: unknown,
): void {
  ctx.emit({
    artifact: 'widget',
    variant,
    payload,
  });
}

function emitCompatProposalArtifact(ctx: CompatTurnContext, result: unknown): void {
  const proposal = extractCompatProposal(result);
  if (!proposal) {
    return;
  }

  const reviewStatus =
    typeof proposal.reviewStatus === 'string' && proposal.reviewStatus === 'blocked'
      ? 'pending'
      : 'pending';
  const diffId =
    asNonEmptyString(proposal.proposalId) ??
    asNonEmptyString(proposal.agentName) ??
    `proposal-${ctx.sessionId}`;

  ctx.emit({
    artifact: 'diff',
    diffId,
    status: reviewStatus,
    payload: proposal,
  });
}

function emitCompatTopologyArtifact(ctx: CompatTurnContext, result: unknown): void {
  const topology = asObjectRecord(result);
  if (!Array.isArray(topology.agents)) {
    return;
  }

  const hasEdges = Array.isArray(topology.edges);
  const hasEntryPoint =
    typeof topology.entryPoint === 'string' || typeof topology.entryAgent === 'string';
  if (!hasEdges && !hasEntryPoint) {
    return;
  }

  ctx.emit({
    artifact: 'topology',
    payload: topology,
  });
}

function emitCompatHealthArtifact(ctx: CompatTurnContext, result: unknown): void {
  const health = asObjectRecord(result);
  const hasOverall = typeof health.overall === 'string';
  const hasAgentSummary = Array.isArray(health.agents) && isRecord(health.summary);
  if (!hasOverall && !hasAgentSummary) {
    return;
  }

  ctx.emit({
    artifact: 'health',
    payload: health,
  });
}

function emitCompatCardArtifact(ctx: CompatTurnContext, event: unknown): void {
  if (!isRecord(event) || typeof event.type !== 'string') {
    return;
  }

  switch (event.type) {
    case 'kb_status_card':
    case 'upload_progress_card':
    case 'search_results_card':
    case 'kb_health_card':
    case 'connector_status_card':
    case 'doc_processing_card':
    case 'integration_suggestion_card':
      emitCompatWidgetArtifact(ctx, event.type, event);
      return;
    default:
      return;
  }
}

function emitCompatToolArtifacts(
  ctx: CompatTurnContext,
  toolName: V4InProjectToolName,
  result: unknown,
): void {
  if (isRecord(result) && result.success === false) {
    return;
  }

  switch (toolName) {
    case 'propose_modification':
      emitCompatProposalArtifact(ctx, result);
      return;
    case 'read_topology':
      emitCompatTopologyArtifact(ctx, result);
      return;
    case 'health_check':
      emitCompatHealthArtifact(ctx, result);
      return;
    case 'recommend_model':
      emitCompatWidgetArtifact(ctx, 'model_comparison', result);
      return;
    case 'analyze_constraints':
      emitCompatWidgetArtifact(ctx, 'constraint_coverage', result);
      return;
    default:
      return;
  }
}

async function executeV4InProjectTool(params: {
  ctx: unknown;
  toolName: V4InProjectToolName;
  projectId?: unknown;
  sessionId?: unknown;
  input?: Record<string, unknown>;
}): Promise<unknown> {
  const compatCtx = params.ctx as CompatTurnContext;
  const resolvedProjectId = resolveCompatProjectId(compatCtx, params.projectId);
  if (!resolvedProjectId) {
    return missingCompatScope(params.toolName, 'project');
  }

  const resolvedSessionId = resolveCompatSessionId(compatCtx, params.sessionId);
  if (!resolvedSessionId) {
    return missingCompatScope(params.toolName, 'session');
  }

  const { buildInProjectTools } = await import('@/lib/arch-ai/tools/in-project-tools');
  const toolSet = buildInProjectTools(
    {
      tenantId: compatCtx.tenantId,
      userId: compatCtx.userId,
      permissions: getCompatPermissions(compatCtx),
    },
    resolvedSessionId,
    resolvedProjectId,
    getCompatAuthToken(compatCtx),
    (event) => {
      emitCompatCardArtifact(compatCtx, event);
    },
    {
      pageContext: getCompatPageContext(compatCtx),
    },
  );
  const tool = toolSet[params.toolName] as
    | { execute?: (input: Record<string, unknown>) => Promise<unknown> }
    | undefined;

  if (typeof tool?.execute !== 'function') {
    return unsupportedCompatTool(params.toolName);
  }

  const result = await tool.execute(params.input ?? {});
  emitCompatToolArtifacts(compatCtx, params.toolName, result);
  return result;
}

function mapReadInsightsInput(input: unknown): Record<string, unknown> {
  const raw = asObjectRecord(input);
  const action =
    raw.action === 'overview' ||
    raw.action === 'quality' ||
    raw.action === 'outcomes' ||
    raw.action === 'agent_performance' ||
    raw.action === 'sentiment' ||
    raw.action === 'tool_performance'
      ? raw.action
      : 'overview';
  return {
    action,
    ...(typeof raw.agentName === 'string' ? { agentName: raw.agentName } : {}),
    ...(typeof raw.timeRange === 'string' ? { timeRange: raw.timeRange } : {}),
  };
}

function mapDiagnoseProjectInput(input: unknown): Record<string, unknown> {
  const raw = asObjectRecord(input);
  const focus = asNonEmptyString(raw.focus) ?? 'all';

  return { focus };
}

function mapConfigureModelInput(input: unknown): Record<string, unknown> {
  const raw = asObjectRecord(input);
  const agentName = asNonEmptyString(raw.agentName) ?? 'all';

  return {
    action: asNonEmptyString(raw.action) ?? 'apply',
    agentName,
    source: asNonEmptyString(raw.source) ?? 'manual',
    ...(typeof raw.modelId === 'string' ? { modelId: raw.modelId } : {}),
    ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}),
    ...(typeof raw.temperature === 'number' ? { temperature: raw.temperature } : {}),
    ...(typeof raw.maxTokens === 'number' ? { maxTokens: raw.maxTokens } : {}),
    ...(raw.operationModels && typeof raw.operationModels === 'object'
      ? { operationModels: raw.operationModels }
      : {}),
    ...(typeof raw.confirmed === 'boolean' ? { confirmed: raw.confirmed } : {}),
  };
}

function mapRunTestInput(input: unknown): Record<string, unknown> {
  const raw = asObjectRecord(input);
  const testMessage = asNonEmptyString(raw.testMessage) ?? asNonEmptyString(raw.message) ?? 'Hello';

  // V4 collapsed standalone run_test into testing_ops with action: 'run_test'.
  return {
    action: 'run_test',
    ...(typeof raw.agentName === 'string' ? { agentName: raw.agentName } : {}),
    testMessage,
  };
}

function mapToolsOpsInput(input: unknown): Record<string, unknown> {
  const raw = asObjectRecord(input);
  const action = asNonEmptyString(raw.action) ?? 'list';
  const toolId = asNonEmptyString(raw.toolId) ?? asNonEmptyString(raw.toolName);

  return {
    action,
    ...(toolId ? { toolId } : {}),
    ...(typeof raw.toolName === 'string' ? { toolName: raw.toolName } : {}),
    ...(raw.config && typeof raw.config === 'object' ? { config: raw.config } : {}),
    ...(raw.testInput && typeof raw.testInput === 'object' ? { testInput: raw.testInput } : {}),
    ...(typeof raw.confirmed === 'boolean' ? { confirmed: raw.confirmed } : {}),
  };
}

function mapManageMemoryInput(input: unknown): Record<string, unknown> {
  const raw = asObjectRecord(input);
  const action = raw.action === 'remove' ? 'delete' : (asNonEmptyString(raw.action) ?? 'list');

  return {
    action,
    ...(typeof raw.content === 'string' ? { content: raw.content } : {}),
    ...(typeof raw.memoryId === 'string' ? { memoryId: raw.memoryId } : {}),
    ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
  };
}

function mapProposeModificationInput(
  inputOrAgentName: unknown,
  change?: unknown,
  updatedCode?: unknown,
): Record<string, unknown> {
  const raw = asObjectRecord(inputOrAgentName);
  if (Object.keys(raw).length > 0) {
    return {
      ...(typeof raw.agentName === 'string' ? { agentName: raw.agentName } : {}),
      ...(typeof raw.change === 'string' ? { change: raw.change } : {}),
      ...(typeof raw.updatedCode === 'string' ? { updatedCode: raw.updatedCode } : {}),
      ...(Array.isArray(raw.sections) ? { sections: raw.sections } : {}),
      ...(typeof raw.isNew === 'boolean' ? { isNew: raw.isNew } : {}),
    };
  }

  return {
    ...(typeof inputOrAgentName === 'string' ? { agentName: inputOrAgentName } : {}),
    ...(typeof change === 'string' ? { change } : {}),
    ...(typeof updatedCode === 'string' ? { updatedCode } : {}),
  };
}

/**
 * Build the v1 Core function refs for all migrated tools.
 * Uses dynamic imports to avoid pulling the entire Studio tool module graph
 * at module evaluation time.
 */
export async function buildV1CoreRefs(): Promise<V1CoreFunctionRefs> {
  const noop: CoreFunction = async () => unsupportedCompatTool('legacy_v1_core_ref');

  return {
    updateSpecification: async (ctx, sessionId, input, value, note) =>
      executeCompatInterviewTool({
        ctx: ctx as CompatTurnContext,
        toolName: 'update_specification',
        explicitSessionId: sessionId,
        input: mapUpdateSpecificationInput(input, value, note),
      }),
    generateTopology: async (ctx, sessionId, input) =>
      executeCompatBlueprintTool({
        ctx: ctx as CompatTurnContext,
        toolName: 'generate_topology',
        explicitSessionId: sessionId,
        input: asObjectRecord(input),
      }),
    proceedToNextPhase: async (ctx, sessionId, input) =>
      executeCompatProceedToNextPhase({
        ctx: ctx as CompatTurnContext,
        explicitSessionId: sessionId,
        input: mapProceedToNextPhaseInput(input),
      }),
    generateAgent: async (ctx, sessionId, input, code) =>
      executeCompatBuildTool({
        ctx: ctx as CompatTurnContext,
        toolName: 'generate_agent',
        explicitSessionId: sessionId,
        input: mapGenerateAgentInput(input, code),
      }),
    compileAbl: async (ctx, sessionId, input, agentName) =>
      executeCompatBuildTool({
        ctx: ctx as CompatTurnContext,
        toolName: 'compile_abl',
        explicitSessionId: sessionId,
        input: mapCompileAblInput(input, agentName),
      }),
    proposeModification: async (ctx, projectId, inputOrAgentName, change, updatedCode) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'propose_modification',
        projectId,
        input: mapProposeModificationInput(inputOrAgentName, change, updatedCode),
      }),
    saveToolDsl: async (ctx, sessionId, input, dslContent) =>
      executeCompatBuildTool({
        ctx: ctx as CompatTurnContext,
        toolName: 'save_tool_dsl',
        explicitSessionId: sessionId,
        buildSubPhase: 'TOOLS',
        input: mapSaveToolDslInput(input, dslContent),
      }),
    kbManage: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'kb_manage',
        projectId,
        input: asObjectRecord(input),
      }),
    kbSearch: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'kb_search',
        projectId,
        input: asObjectRecord(input),
      }),
    kbHealth: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'kb_health',
        projectId,
        input: asObjectRecord(input),
      }),
    kbIngest: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'kb_ingest',
        projectId,
        input: asObjectRecord(input),
      }),
    kbConnector: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'kb_connector',
        projectId,
        input: asObjectRecord(input),
      }),
    kbDocuments: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'kb_documents',
        projectId,
        input: asObjectRecord(input),
      }),
    kbCrawl: async () => unsupportedCompatTool('kb_crawl'),
    kbSchema: async () => unsupportedCompatTool('kb_schema'),
    readJournal: async (ctx, sessionId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'read_journal',
        sessionId,
        input: asObjectRecord(input),
      }),
    readTopology: async (ctx, projectId) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'read_topology',
        projectId,
      }),
    readAgent: async (ctx, projectId, agentName) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'read_agent',
        projectId,
        input: agentName ? { agentName } : {},
      }),
    readInsights: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'read_insights',
        projectId,
        input: mapReadInsightsInput(input),
      }),
    sessionOps: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'session_ops',
        projectId,
        input: asObjectRecord(input),
      }),
    traceDiagnosis: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'trace_diagnosis',
        projectId,
        input: asObjectRecord(input),
      }),
    queryTraces: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'query_traces',
        projectId,
        input: asObjectRecord(input),
      }),
    applyModification: async (ctx, projectId, agentName, isNew) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'apply_modification',
        projectId,
        input: {
          ...(typeof agentName === 'string' ? { agentName } : {}),
          ...(typeof isNew === 'boolean' ? { isNew } : {}),
        },
      }),
    dismissProposal: async (ctx, sessionId) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'dismiss_proposal',
        sessionId,
      }),
    validateAgent: async (ctx, projectId, agentName, code, depth) => {
      const compatCtx = ctx as CompatTurnContext;
      const resolvedProjectId = resolveCompatProjectId(compatCtx, projectId);
      const resolvedAgentName = asNonEmptyString(agentName);
      if (!resolvedProjectId) {
        return missingCompatScope('validate_agent', 'project');
      }
      if (!resolvedAgentName) {
        return {
          success: false,
          error: {
            code: 'AGENT_REQUIRED',
            message: 'validate_agent requires an agent name.',
          },
        };
      }

      if (typeof code === 'string' && code.length > 0) {
        const { validateProjectAgentCode } = await import('@/lib/arch-ai/tools/in-project-tools');
        return validateProjectAgentCode(
          {
            tenantId: compatCtx.tenantId,
            userId: compatCtx.userId,
            permissions: getCompatPermissions(compatCtx),
          },
          resolvedProjectId,
          resolvedAgentName,
          code,
        );
      }

      return executeV4InProjectTool({
        ctx,
        toolName: 'validate_agent',
        projectId,
        input: {
          agentName: resolvedAgentName,
          ...(depth === 'quick' || depth === 'deep' ? { depth } : {}),
        },
      });
    },
    diagnoseProject: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'diagnose_project',
        projectId,
        input: mapDiagnoseProjectInput(input),
      }),
    explainDiagnostic: async (ctx, code, context) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'explain_diagnostic',
        input: {
          ...(typeof code === 'string' ? { code } : {}),
          ...(typeof context === 'string' && context.length > 0 ? { agentName: context } : {}),
        },
      }),
    healthCheck: async (ctx, projectId) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'health_check',
        projectId,
      }),
    analyzeConstraints: async (ctx, projectId, agentName) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'analyze_constraints',
        projectId,
        input: typeof agentName === 'string' ? { agentName } : {},
      }),
    toolsOps: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'tools_ops',
        projectId,
        input: mapToolsOpsInput(input),
      }),
    mcpServerOps: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'mcp_server_ops',
        projectId,
        input: asObjectRecord(input),
      }),
    variableOps: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'variable_ops',
        projectId,
        input: asObjectRecord(input),
      }),
    integrationOps: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'integration_ops',
        projectId,
        input: asObjectRecord(input),
      }),
    projectConfig: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'project_config',
        projectId,
        input: asObjectRecord(input),
      }),
    authOps: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'auth_ops',
        projectId,
        input: asObjectRecord(input),
      }),
    recommendModel: async (ctx, projectId, agentName) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'recommend_model',
        projectId,
        input: typeof agentName === 'string' ? { agentName } : {},
      }),
    configureModel: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'configure_model',
        projectId,
        input: mapConfigureModelInput(input),
      }),
    runTest: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'testing_ops',
        projectId,
        input: mapRunTestInput(input),
      }),
    manageMemory: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'manage_memory',
        projectId,
        input: mapManageMemoryInput(input),
      }),
    platformContext: async (ctx, projectId, input) =>
      executeV4InProjectTool({
        ctx,
        toolName: 'platform_context',
        projectId,
        input: asObjectRecord(input),
      }),
  };
}
