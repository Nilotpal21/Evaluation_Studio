/**
 * Source of truth for v1 tool classification per spec §7.
 * Update when a new v1 tool is added; missing entries throw at registration time.
 *
 * Reconciled against the REAL v1 tool inventory from:
 *   apps/studio/src/lib/arch-ai/tools/{interview,blueprint,build,in-project}-tools.ts
 */
export const TOOL_CLASSIFICATION = {
  // INTERVIEW phase
  update_specification: 'internal',

  // BLUEPRINT phase
  generate_topology: 'internal',
  proceed_to_next_phase: 'internal',

  // BUILD phase
  generate_agent: 'internal',
  compile_abl: 'internal',
  dry_run_compile: 'internal',
  run_feasibility_check: 'internal',
  get_construct_spec: 'internal',
  list_valid_combinations: 'internal',
  get_cel_grammar: 'internal',
  lookup_validation_code: 'internal',
  propose_plan: 'internal',
  propose_modification: 'internal',
  apply_modification: 'internal',
  dismiss_proposal: 'internal',
  save_tool_dsl: 'internal',

  // IN_PROJECT — read / query
  read_journal: 'internal',
  read_topology: 'internal',
  read_blueprint: 'internal',
  propose_blueprint_edit: 'internal',
  lock_blueprint_version: 'internal',
  fork_blueprint: 'internal',
  rebuild_agents_from_blueprint: 'internal',
  get_topology_patterns: 'internal',
  read_agent: 'internal',
  read_insights: 'internal',
  session_ops: 'internal',
  trace_diagnosis: 'internal',
  query_traces: 'internal',
  find_memory_refs: 'internal',
  find_gather_field_refs: 'internal',
  find_tool_consumers: 'internal',
  find_agent_refs: 'internal',
  find_cel_var_refs: 'internal',

  // IN_PROJECT — diagnostics
  validate_agent: 'internal',
  diagnose_project: 'internal',
  explain_diagnostic: 'internal',
  health_check: 'internal',
  analyze_constraints: 'internal',

  // IN_PROJECT — ops
  tools_ops: 'internal',
  mcp_server_ops: 'internal',
  project_config: 'internal',
  auth_ops: 'internal',
  platform_context: 'internal',
  external_agent_ops: 'internal',

  // IN_PROJECT — ops (extended set; backfill keeps `ToolName` union in sync
  // with the union in `packages/arch-ai/src/types/tools.ts`. Adding a tool
  // there requires adding the matching kind here, otherwise `toolKind()`
  // throws at registration time.)
  agent_ops: 'internal',
  deployment_ops: 'internal',
  testing_ops: 'internal',
  analytics_ops: 'internal',
  variable_ops: 'internal',
  integration_ops: 'internal',
  connection_ops: 'internal',

  // IN_PROJECT — model management
  recommend_model: 'internal',
  configure_model: 'internal',

  // IN_PROJECT — testing
  run_test: 'internal',
  run_simulation: 'internal',

  // IN_PROJECT — memory
  manage_memory: 'internal',

  // Knowledge base tools
  kb_manage: 'internal',
  kb_search: 'internal',
  kb_health: 'internal',
  kb_ingest: 'internal',
  kb_connector: 'internal',
  kb_documents: 'internal',
  kb_crawl: 'internal',
  kb_schema: 'internal',

  // IN_PROJECT — knowledge retrieval
  search_docs: 'internal',

  // Interactive — only these surface as chat widgets
  ask_user: 'interactive',
  collect_file: 'interactive',
  collect_secret: 'interactive',
} as const;

export type ToolName = keyof typeof TOOL_CLASSIFICATION;
export type ToolKind = (typeof TOOL_CLASSIFICATION)[ToolName];

export function toolKind(name: string): ToolKind {
  if (!(name in TOOL_CLASSIFICATION)) {
    throw new Error(`unknown tool: "${name}" — add it to TOOL_CLASSIFICATION in classification.ts`);
  }
  return TOOL_CLASSIFICATION[name as ToolName];
}
