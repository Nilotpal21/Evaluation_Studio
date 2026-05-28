/**
 * Tool types — Contract: tool-registry.md
 *
 * IMPORTANT — DUAL TOOLNAME ALIGNMENT:
 * Every entry in this union must also have a kind in
 * `packages/arch-ai/src/tools/adapters/classification.ts:TOOL_CLASSIFICATION`.
 * `classification.ts` exports its own `ToolName = keyof typeof TOOL_CLASSIFICATION`
 * which is consumed by `toolKind()`; a tool that exists here but is missing
 * from the classification map throws at registration time.
 */

import type { AnySpecialistId, SPECIALIST_IDS } from './constants.js';
import type { ArchPhase } from './session.js';

export type SpecialistId = (typeof SPECIALIST_IDS)[number];

export type ToolName =
  | 'ask_user'
  | 'collect_file'
  | 'update_specification'
  | 'generate_topology'
  | 'generate_agent'
  | 'compile_abl'
  | 'dry_run_compile'
  | 'run_feasibility_check'
  | 'get_construct_spec'
  | 'list_valid_combinations'
  | 'get_cel_grammar'
  | 'lookup_validation_code'
  | 'propose_plan'
  | 'propose_modification'
  | 'create_project'
  | 'proceed_to_next_phase'
  | 'query_traces'
  | 'trace_diagnosis'
  | 'session_ops'
  | 'run_test'
  | 'run_simulation'
  | 'health_check'
  | 'read_agent'
  | 'apply_modification'
  | 'read_journal'
  | 'find_memory_refs'
  | 'find_gather_field_refs'
  | 'find_tool_consumers'
  | 'find_agent_refs'
  | 'find_cel_var_refs'
  | 'read_topology'
  | 'read_blueprint'
  | 'propose_blueprint_edit'
  | 'lock_blueprint_version'
  | 'fork_blueprint'
  | 'rebuild_agents_from_blueprint'
  | 'get_topology_patterns'
  | 'recommend_model'
  | 'analyze_constraints'
  | 'read_insights'
  | 'validate_agent'
  | 'diagnose_project'
  | 'explain_diagnostic'
  | 'dismiss_proposal'
  | 'project_config'
  | 'configure_model'
  | 'auth_ops'
  | 'collect_secret'
  | 'tools_ops'
  | 'mcp_server_ops'
  | 'external_agent_ops'
  | 'variable_ops'
  | 'integration_ops'
  | 'connection_ops'
  | 'save_tool_dsl'
  | 'platform_context'
  | 'manage_memory'
  | 'kb_manage'
  | 'kb_ingest'
  | 'kb_search'
  | 'kb_health'
  | 'kb_connector'
  | 'kb_documents'
  | 'agent_ops'
  | 'deployment_ops'
  | 'testing_ops'
  | 'analytics_ops'
  | 'search_docs';

export type ToolType = 'client-side' | 'server-side';

export interface ToolDefinition {
  name: ToolName;
  type: ToolType;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Contract: tool-registry.md — Phase-to-Tool Mapping
 * The coordinator hard-filters tools per phase. This is not a hint.
 */
export type PhaseToolMap = Record<ArchPhase, readonly ToolName[]>;

export const PHASE_TOOL_MAP: PhaseToolMap = {
  INTERVIEW: [
    'ask_user',
    'collect_file',
    'update_specification',
    'proceed_to_next_phase',
    'platform_context',
  ],
  BLUEPRINT: ['ask_user', 'collect_file', 'generate_topology', 'proceed_to_next_phase'],
  BUILD: [
    'ask_user',
    'collect_file',
    'generate_agent',
    'compile_abl',
    'propose_modification',
    'proceed_to_next_phase',
  ],
  CREATE: ['ask_user', 'create_project'],
} as const;

const IN_PROJECT_DEFAULT_SPECIALIST = 'in-project-architect' as const;

const KB_TOOL_NAMES = [
  'kb_manage',
  'kb_ingest',
  'kb_search',
  'kb_health',
  'kb_connector',
  'kb_documents',
] as const satisfies readonly ToolName[];

const REFERENCE_TOOL_NAMES = [
  'find_memory_refs',
  'find_gather_field_refs',
  'find_tool_consumers',
  'find_agent_refs',
  'find_cel_var_refs',
] as const satisfies readonly ToolName[];

const KNOWLEDGE_SPINE_TOOL_NAMES = [
  'get_construct_spec',
  'list_valid_combinations',
  'get_cel_grammar',
  'lookup_validation_code',
] as const satisfies readonly ToolName[];

/**
 * Stable tool ownership for IN_PROJECT turns.
 *
 * New turns use the unified in-project-architect profile. Legacy specialist
 * profiles remain for old session records and explicit overrides.
 */
export const IN_PROJECT_SPECIALIST_TOOL_MAP = {
  'in-project-architect': [
    'read_agent',
    'read_topology',
    'read_blueprint',
    'get_topology_patterns',
    'read_journal',
    ...KNOWLEDGE_SPINE_TOOL_NAMES,
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_blueprint_edit',
    'lock_blueprint_version',
    'fork_blueprint',
    'rebuild_agents_from_blueprint',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'dry_run_compile',
    'run_feasibility_check',
    'validate_agent',
    'diagnose_project',
    'explain_diagnostic',
    'analyze_constraints',
    'session_ops',
    'query_traces',
    'trace_diagnosis',
    'run_simulation',
    'health_check',
    'ask_user',
    'collect_file',
    'collect_secret',
    'project_config',
    'platform_context',
    'configure_model',
    'recommend_model',
    'auth_ops',
    'tools_ops',
    'mcp_server_ops',
    'external_agent_ops',
    'variable_ops',
    'integration_ops',
    'connection_ops',
    'save_tool_dsl',
    'manage_memory',
    'agent_ops',
    'deployment_ops',
    'testing_ops',
    'analytics_ops',
    'read_insights',
    'search_docs',
    ...KB_TOOL_NAMES,
  ],
  diagnostician: [
    'validate_agent',
    'diagnose_project',
    'explain_diagnostic',
    'analyze_constraints',
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'session_ops',
    'query_traces',
    'trace_diagnosis',
    'run_simulation',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'health_check',
    'ask_user',
    'collect_file',
    'project_config',
    'platform_context',
    'configure_model',
    'recommend_model',
    'agent_ops',
    'manage_memory',
    'search_docs',
    ...KB_TOOL_NAMES,
  ],
  'abl-construct-expert': [
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'read_topology',
    'get_topology_patterns',
    'run_simulation',
    'health_check',
    'ask_user',
    'collect_file',
    'project_config',
    'tools_ops',
    'agent_ops',
    'platform_context',
    'configure_model',
    'recommend_model',
    'analyze_constraints',
    'manage_memory',
    'search_docs',
    ...KB_TOOL_NAMES,
  ],
  'channel-voice': [
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'ask_user',
    'platform_context',
    'manage_memory',
    'search_docs',
  ],
  'entity-collection': [
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'ask_user',
    'platform_context',
    'manage_memory',
    'search_docs',
  ],
  analyst: [
    'read_insights',
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'session_ops',
    'query_traces',
    'trace_diagnosis',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'ask_user',
    'platform_context',
    'manage_memory',
    'search_docs',
    'testing_ops',
    'run_simulation',
    'analytics_ops',
  ],
  observer: [
    'read_insights',
    'session_ops',
    'query_traces',
    'trace_diagnosis',
    'read_agent',
    'read_journal',
    'read_topology',
    'validate_agent',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'ask_user',
    'platform_context',
    'manage_memory',
    'search_docs',
    'analytics_ops',
  ],
  'multi-agent-architect': [
    'read_agent',
    'read_topology',
    'get_topology_patterns',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'ask_user',
    'project_config',
    'agent_ops',
    'platform_context',
    'manage_memory',
    'search_docs',
    'deployment_ops',
  ],
  'testing-eval': [
    'testing_ops',
    'run_simulation',
    'session_ops',
    'trace_diagnosis',
    'query_traces',
    'read_agent',
    'read_journal',
    'compile_abl',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'ask_user',
    'platform_context',
    'manage_memory',
    'search_docs',
    ...KB_TOOL_NAMES,
  ],
  'integration-methodologist': [
    'read_agent',
    'read_journal',
    ...REFERENCE_TOOL_NAMES,
    'propose_plan',
    'propose_modification',
    'apply_modification',
    'dismiss_proposal',
    'compile_abl',
    'ask_user',
    'project_config',
    'tools_ops',
    'mcp_server_ops',
    'external_agent_ops',
    'variable_ops',
    'auth_ops',
    'collect_secret',
    'integration_ops',
    'connection_ops',
    'platform_context',
    'manage_memory',
    'search_docs',
    'deployment_ops',
    'collect_file',
    ...KB_TOOL_NAMES,
  ],
} as const satisfies Partial<Record<AnySpecialistId, readonly ToolName[]>>;

const inProjectToolNameSet = new Set<ToolName>();
for (const toolNames of Object.values(IN_PROJECT_SPECIALIST_TOOL_MAP)) {
  for (const toolName of toolNames) {
    inProjectToolNameSet.add(toolName);
  }
}

/**
 * Superset of all tools that can be surfaced during IN_PROJECT turns.
 * Derived from the per-specialist profiles above so the contract stays aligned.
 */
export const IN_PROJECT_TOOLS: readonly ToolName[] = Array.from(inProjectToolNameSet);

export function getInProjectToolNamesForSpecialist(
  specialist: AnySpecialistId | string | undefined,
): readonly ToolName[] {
  const fallbackTools = IN_PROJECT_SPECIALIST_TOOL_MAP[IN_PROJECT_DEFAULT_SPECIALIST];
  if (!specialist) {
    return fallbackTools;
  }

  return (
    IN_PROJECT_SPECIALIST_TOOL_MAP[specialist as keyof typeof IN_PROJECT_SPECIALIST_TOOL_MAP] ??
    fallbackTools
  );
}

/**
 * Client-side tools: no server-side execute function.
 * Contract 8 (tool-registry): "ask_user, collect_file, and collect_secret do NOT have a
 * server-side execution function."
 * Contract 13 (execution-model): when called, stream ENDS and waits for user.
 */
export const CLIENT_SIDE_TOOLS: readonly ToolName[] = [
  'ask_user',
  'collect_file',
  'collect_secret',
] as const;

export function isClientSideTool(name: string): boolean {
  return (CLIENT_SIDE_TOOLS as readonly string[]).includes(name);
}

export function getToolsForPhase(phase: ArchPhase, allTools: ToolDefinition[]): ToolDefinition[] {
  const allowed = PHASE_TOOL_MAP[phase];
  return allTools.filter((tool) => (allowed as readonly string[]).includes(tool.name));
}

export function getToolsForInProject(allTools: ToolDefinition[]): ToolDefinition[] {
  return allTools.filter((tool) => (IN_PROJECT_TOOLS as readonly string[]).includes(tool.name));
}
