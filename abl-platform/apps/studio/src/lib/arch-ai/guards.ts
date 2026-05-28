import { hasPermission } from '@/lib/permission-resolver';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('arch-ai:guards');

/** Map tool actions to platform permission strings (resource:operation) */
export const ACTION_TO_PERMISSION: Record<string, Record<string, string>> = {
  agent_ops: {
    read: 'agent:read',
    list: 'agent:read',
    create: 'agent:update',
    modify: 'agent:update',
    compile: 'agent:read',
    delete: 'agent:delete',
    propose_modification: 'agent:read',
  },
  find_memory_refs: {
    read: 'agent:read',
  },
  find_gather_field_refs: {
    read: 'agent:read',
  },
  find_tool_consumers: {
    read: 'agent:read',
  },
  find_agent_refs: {
    read: 'agent:read',
  },
  find_cel_var_refs: {
    read: 'agent:read',
  },
  analyze: {
    explain: 'agent:read',
    suggest: 'agent:read',
    test: 'agent:read',
    query_traces: 'session:read',
  },
  tools_ops: {
    read: 'tool:read',
    list: 'tool:read',
    create: 'tool:write',
    update: 'tool:write',
    test: 'tool:execute',
    delete: 'tool:delete',
  },
  mcp_server_ops: {
    list: 'tool:read',
    read: 'tool:read',
    create: 'tool:write',
    update: 'tool:write',
    delete: 'tool:delete',
    test_connection: 'tool:read',
    discover_preview: 'tool:read',
    import_tools: 'tool:write',
    list_tools: 'tool:read',
    test_tool: 'tool:execute',
  },
  external_agent_ops: {
    list: 'external_agent:read',
    read: 'external_agent:read',
    discover_preview: 'external_agent:read',
    create: 'external_agent:create',
    update: 'external_agent:update',
    delete: 'external_agent:delete',
    test_connection: 'external_agent:update',
  },
  variable_ops: {
    list: 'project:read',
    list_namespaces: 'project:read',
    create: 'project:update',
    update: 'project:update',
    delete: 'project:update',
    link_namespace: 'project:update',
  },
  integration_ops: {
    start: 'project:update',
    get_active: 'project:read',
    list: 'project:read',
    update: 'project:update',
    run_tool_test: 'tool:execute',
    complete: 'project:update',
    archive: 'project:update',
    revalidate: 'project:update',
  },
  topology_ops: {
    read: 'agent:read',
    modify: 'agent:update',
  },
  testing_ops: {
    run_test: 'session:execute',
    create_eval: 'session:execute',
    list_evals: 'session:read',
  },
  deployment_ops: {
    list: 'deployment:read',
    deploy: 'deployment:create',
    promote: 'deployment:create',
    configure_channel: 'channel:update',
    list_channels: 'channel:read',
  },
  knowledge_ops: {
    list: 'tool:read',
    create: 'tool:write',
    add_document: 'tool:write',
    query: 'tool:read',
    delete: 'tool:delete',
  },
  kb_manage: {
    list: 'tool:read',
    create: 'tool:write',
    get: 'tool:read',
    update: 'tool:write',
    delete: 'tool:delete',
  },
  kb_ingest: {
    upload_file: 'tool:write',
    add_url: 'tool:write',
    add_text: 'tool:write',
    list_sources: 'tool:read',
  },
  kb_search: {
    query: 'tool:read',
    structured_query: 'tool:read',
    discover: 'tool:read',
    resolve_vocab: 'tool:read',
  },
  kb_health: {
    summary: 'tool:read',
    errors: 'tool:read',
    retry_failed: 'tool:write',
    sync_counters: 'tool:write',
    check_operation: 'tool:read',
  },
  kb_connector: {
    list: 'tool:read',
    create: 'tool:write',
    auth: 'tool:write',
    sync_start: 'tool:write',
    sync_status: 'tool:read',
    sync_pause: 'tool:write',
  },
  kb_documents: {
    list: 'tool:read',
    status_summary: 'tool:read',
    reprocess: 'tool:write',
    delete: 'tool:delete',
  },
  session_ops: {
    list: 'session:read',
    get: 'session:read',
    get_analysis: 'session:read',
  },
  analytics_ops: {
    metrics: 'session:read',
    intents: 'session:read',
    quality_scores: 'session:read',
    anomalies: 'session:read',
  },
  trace_diagnosis: {
    discover: 'session:read',
    deep_dive: 'session:read',
    compare: 'session:read',
    explain: 'session:read',
    aggregate: 'session:read',
    errors: 'session:read',
  },
  platform_context: {
    get_summary: 'project:read',
    list_agents: 'agent:read',
    list_models: 'project:read',
    list_tools: 'tool:read',
    list_channels: 'connection:read',
    list_auth_profiles: 'auth_profile:read',
  },
  auth_ops: {
    read: 'auth_profile:read',
    list: 'auth_profile:read',
    create: 'auth_profile:write',
    update: 'auth_profile:write',
    delete: 'auth_profile:delete',
    validate: 'auth_profile:write',
  },
  connection_ops: {
    list: 'connection:read',
    create: 'connection:write',
    delete: 'connection:delete',
    resolve_options: 'connection:read',
    resolve_dynamic_props: 'connection:read',
  },
  health_check: {
    run_check: 'agent:read',
  },
  project_config: {
    get_config: 'project:read',
    update_config: 'project:update',
    get_settings: 'model_config:read',
    update_settings: 'model_config:write',
  },
  configure_model: {
    inspect: 'agent:read',
    diff: 'agent:read',
    apply: 'agent:update',
  },
};

/** Dangerous actions that ALWAYS need explicit user confirmation.
 * SECURITY: Any action that can destroy data, affect production, or modify
 * topology must be in this list. The LLM must call ask_user(confirmation)
 * before these actions execute. */
export const DANGEROUS_ACTIONS: Record<string, string[]> = {
  agent_ops: ['delete'],
  tools_ops: ['delete'],
  mcp_server_ops: ['delete'],
  external_agent_ops: ['delete'],
  variable_ops: ['delete'],
  knowledge_ops: ['delete'],
  kb_manage: ['delete'],
  kb_documents: ['delete'],
  // 'rollback' was previously listed but no executor case exists — drop until reimplemented.
  deployment_ops: ['deploy', 'promote', 'configure_channel'],
  topology_ops: ['modify'],
  project_config: ['update_settings'],
  auth_ops: ['delete'],
  connection_ops: ['delete'],
  configure_model: ['apply'],
};

export function isDangerousAction(tool: string, action: string): boolean {
  return DANGEROUS_ACTIONS[tool]?.includes(action) ?? false;
}

export interface ToolPermissionContext {
  projectId: string;
  agentId?: string;
  sessionId?: string;
  user: { permissions: string[]; tenantId: string; userId: string };
  /** Forwarded JWT for server-side runtime API calls (testing, traces). */
  authToken?: string;
  /**
   * Opt-in switch for plan-first mutation enforcement. Until `pendingPlan`
   * is fully wired into the tool factory, callers omit this and the guard is
   * classification-only. Once wired, every proposal-covered mutation must pass
   * an approved plan through this context.
   */
  requireApprovedPlanForMutation?: boolean;
  approvedPlan?: {
    id: string;
    projectId?: string;
    status: 'approved';
    plannedMutations?: ArchMutationIntent[];
  };
}

export interface ArchMutationIntent {
  targetKind:
    | 'agent_dsl'
    | 'agent_topology'
    | 'project_memory'
    | 'tool_binding'
    | 'project_config'
    | 'integration_config'
    | 'test_or_eval';
  agentName?: string;
  operation: 'create' | 'modify' | 'delete' | 'rename' | 'apply';
  affectedConstructs?: string[];
  sourceTool: string;
  sourceAction: string;
}

export const ARCH_MUTATING_ACTIONS: Record<string, readonly string[]> = {
  propose_modification: ['propose'],
  apply_modification: ['apply'],
  agent_ops: ['create', 'modify', 'delete'],
  tools_ops: ['create', 'update', 'delete'],
  project_config: ['update_config', 'update_settings'],
  manage_memory: ['add', 'delete'],
  integration_ops: ['start', 'update', 'complete', 'archive', 'revalidate'],
  connection_ops: ['create', 'delete'],
  variable_ops: ['create', 'update', 'delete', 'link_namespace'],
  testing_ops: ['create_eval'],
  configure_model: ['apply'],
  mcp_server_ops: ['create', 'update', 'delete', 'import_tools'],
  external_agent_ops: ['create', 'update', 'delete', 'test_connection'],
  auth_ops: ['create', 'update', 'delete', 'validate'],
  kb_manage: ['create', 'update', 'delete'],
  kb_ingest: ['upload_file', 'add_url', 'add_text'],
  kb_health: ['retry_failed', 'sync_counters'],
  kb_connector: ['create', 'auth', 'sync_start', 'sync_pause'],
  kb_documents: ['reprocess', 'delete'],
} as const;

const ARCH_MUTATION_TARGETS: Record<string, ArchMutationIntent['targetKind']> = {
  propose_modification: 'agent_dsl',
  apply_modification: 'agent_dsl',
  agent_ops: 'agent_dsl',
  tools_ops: 'tool_binding',
  project_config: 'project_config',
  manage_memory: 'project_memory',
  integration_ops: 'integration_config',
  connection_ops: 'integration_config',
  variable_ops: 'integration_config',
  testing_ops: 'test_or_eval',
  configure_model: 'project_config',
  mcp_server_ops: 'tool_binding',
  external_agent_ops: 'agent_topology',
  auth_ops: 'integration_config',
  kb_manage: 'project_memory',
  kb_ingest: 'project_memory',
  kb_health: 'project_memory',
  kb_connector: 'project_memory',
  kb_documents: 'project_memory',
};

export function isArchMutationAction(toolName: string, action: string): boolean {
  return ARCH_MUTATING_ACTIONS[toolName]?.includes(action) ?? false;
}

function mutationMatchesApprovedPlan(
  intent: ArchMutationIntent,
  approvedPlan: NonNullable<ToolPermissionContext['approvedPlan']>,
): boolean {
  const plannedMutations = approvedPlan.plannedMutations ?? [];
  if (plannedMutations.length === 0) {
    return false;
  }

  return plannedMutations.some((planned) => {
    const intentAgent = intent.agentName?.trim().toLowerCase();
    const plannedAgent = planned.agentName?.trim().toLowerCase();
    const agentScoped =
      intent.targetKind === 'agent_dsl' ||
      intent.targetKind === 'agent_topology' ||
      planned.targetKind === 'agent_dsl' ||
      planned.targetKind === 'agent_topology';
    const sameAgent = agentScoped
      ? Boolean(intentAgent && plannedAgent && intentAgent === plannedAgent)
      : !intentAgent || !plannedAgent || intentAgent === plannedAgent;
    const sameTargetKind = planned.targetKind === intent.targetKind;
    const sameOperation =
      planned.operation === intent.operation ||
      (intent.sourceTool === 'propose_modification' &&
        planned.targetKind === 'agent_dsl' &&
        planned.operation === 'modify') ||
      (intent.sourceTool === 'apply_modification' &&
        planned.targetKind === 'agent_dsl' &&
        (planned.operation === 'modify' || planned.operation === 'create'));
    const sameSource =
      planned.sourceTool === intent.sourceTool ||
      (intent.sourceTool === 'propose_modification' && planned.sourceTool === 'agent_ops') ||
      (intent.sourceTool === 'apply_modification' &&
        (planned.sourceTool === 'agent_ops' || planned.sourceTool === 'propose_modification'));

    return sameTargetKind && sameOperation && sameSource && sameAgent;
  });
}

function inferMutationOperation(action: string): ArchMutationIntent['operation'] {
  if (action === 'create' || action === 'delete' || action === 'apply') {
    return action;
  }
  if (action === 'import_tools') {
    return 'create';
  }
  return 'modify';
}

export function buildArchMutationIntent(
  toolName: string,
  action: string,
): ArchMutationIntent | null {
  if (!isArchMutationAction(toolName, action)) {
    return null;
  }

  return {
    targetKind: ARCH_MUTATION_TARGETS[toolName] ?? 'project_config',
    operation: inferMutationOperation(action),
    sourceTool: toolName,
    sourceAction: action,
  };
}

export function checkArchMutationAllowed(
  intent: ArchMutationIntent,
  ctx: ToolPermissionContext,
): { allowed: boolean; error?: { code: string; message: string } } {
  if (!isArchMutationAction(intent.sourceTool, intent.sourceAction)) {
    return { allowed: true };
  }

  if (!ctx.requireApprovedPlanForMutation) {
    return { allowed: true };
  }

  if (
    ctx.approvedPlan?.status === 'approved' &&
    ctx.approvedPlan.projectId &&
    ctx.approvedPlan.projectId !== ctx.projectId
  ) {
    log.info('Arch mutation blocked because approved plan belongs to another project', {
      toolName: intent.sourceTool,
      action: intent.sourceAction,
      targetKind: intent.targetKind,
      operation: intent.operation,
      projectId: ctx.projectId,
      approvedPlanProjectId: ctx.approvedPlan.projectId,
      agentName: intent.agentName,
      userId: ctx.user.userId,
    });
    return {
      allowed: false,
      error: {
        code: 'PLAN_SCOPE_MISMATCH',
        message:
          'Approved plan does not cover this mutation. Call propose_plan with the correct scope first.',
      },
    };
  }

  if (
    ctx.approvedPlan?.status === 'approved' &&
    mutationMatchesApprovedPlan(intent, ctx.approvedPlan)
  ) {
    return { allowed: true };
  }

  log.info('Arch mutation blocked because no approved plan is attached', {
    toolName: intent.sourceTool,
    action: intent.sourceAction,
    targetKind: intent.targetKind,
    operation: intent.operation,
    projectId: ctx.projectId,
    agentName: intent.agentName,
    userId: ctx.user.userId,
  });

  return {
    allowed: false,
    error: {
      code: ctx.approvedPlan?.status === 'approved' ? 'PLAN_SCOPE_MISMATCH' : 'PLAN_REQUIRED',
      message:
        ctx.approvedPlan?.status === 'approved'
          ? 'Approved plan does not cover this mutation. Call propose_plan with the correct scope first.'
          : 'Plan required before mutation. Call propose_plan first.',
    },
  };
}

export async function checkToolPermission(
  toolName: string,
  action: string,
  ctx: ToolPermissionContext,
): Promise<{ allowed: boolean; error?: string; code?: string }> {
  const mutationIntent = buildArchMutationIntent(toolName, action);
  if (mutationIntent) {
    const mutationCheck = checkArchMutationAllowed(mutationIntent, ctx);
    if (!mutationCheck.allowed) {
      return {
        allowed: false,
        code: mutationCheck.error?.code,
        error: mutationCheck.error?.message ?? 'Plan required before mutation',
      };
    }
  }

  const permission = ACTION_TO_PERMISSION[toolName]?.[action];
  if (!permission) {
    log.warn('Unknown tool action, allowing by default', { toolName, action });
    return { allowed: true };
  }

  const allowed = hasPermission(ctx.user.permissions, permission);
  if (!allowed) {
    log.info('Permission denied', {
      toolName,
      action,
      permission,
      userId: ctx.user.userId,
    });
  }
  return {
    allowed,
    error: allowed ? undefined : `Permission denied: ${permission} required`,
  };
}
