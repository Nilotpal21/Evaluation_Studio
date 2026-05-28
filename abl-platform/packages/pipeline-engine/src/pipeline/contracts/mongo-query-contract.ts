/**
 * DbQueryContract — allowlist and operator constraints for the db-query node.
 *
 * Single source of truth imported by:
 *   - db-query.service.ts  (runtime enforcement)
 *   - apps/runtime/src/routes/analytics.ts  (serves lists to Studio)
 */

export interface MongoCollectionDescriptor {
  name: string;
  description: string;
  /** Pre-filled query shown in the Studio form when this collection is selected. */
  defaultQuery: string;
}

export interface ClickHouseTableDescriptor {
  name: string;
  description: string;
  /** Pre-filled SQL shown in the Studio form when this table is selected. */
  defaultQuery: string;
}

export const ALLOWED_MONGO_COLLECTIONS: readonly MongoCollectionDescriptor[] = [
  {
    name: 'messages',
    description: 'Conversation messages written after session close',
    defaultQuery: '{}',
  },
  {
    name: 'custom_pipeline_results',
    description: 'Custom pipeline evaluation results written by store-results nodes',
    defaultQuery: '{}',
  },
];

// ── ClickHouse tables (session_id-indexed only — aggregate tables excluded) ──

// session_id is auto-injected by the executor — no need to include it in the user's query.
const CH_DEFAULT_QUERY = (table: string) =>
  `SELECT *\nFROM ${table}\nWHERE tenant_id = {tenantId:String}\n  AND project_id = {projectId:String}\nLIMIT 100`;

export const ALLOWED_CLICKHOUSE_TABLES: readonly ClickHouseTableDescriptor[] = [
  {
    name: 'abl_platform.platform_events_by_session',
    description: 'All session events ordered by session_id — fastest for session-scoped queries',
    defaultQuery: CH_DEFAULT_QUERY('abl_platform.platform_events_by_session'),
  },
  {
    name: 'abl_platform.platform_events',
    description: 'All analytics events (sessions, LLM/tool calls, agent events)',
    defaultQuery: CH_DEFAULT_QUERY('abl_platform.platform_events'),
  },
  {
    name: 'abl_platform.llm_metrics',
    description: 'Per-call LLM usage: tokens, cost, latency, model, provider',
    defaultQuery: CH_DEFAULT_QUERY('abl_platform.llm_metrics'),
  },
  {
    name: 'abl_platform.messages',
    description: 'Conversation messages (user, assistant, system) after session close',
    defaultQuery: CH_DEFAULT_QUERY('abl_platform.messages'),
  },
  {
    name: 'abl_platform.insight_results',
    description: 'Pipeline evaluation results (score, status, dimensions) per session',
    defaultQuery: CH_DEFAULT_QUERY('abl_platform.insight_results'),
  },
  {
    name: 'abl_platform.custom_pipeline_results',
    description: 'Custom pipeline run results: scores, output JSON, execution metadata',
    defaultQuery: CH_DEFAULT_QUERY('abl_platform.custom_pipeline_results'),
  },
  {
    name: 'abl_platform.spatial_trace_records',
    description: 'Agent/tool trace spans with sti_path, span/agent/tool identifiers',
    defaultQuery: CH_DEFAULT_QUERY('abl_platform.spatial_trace_records'),
  },
  {
    name: 'abl_platform.audit_events',
    description: 'Auth/authz and resource-change audit trail',
    defaultQuery: CH_DEFAULT_QUERY('abl_platform.audit_events'),
  },
  {
    name: 'abl_platform.search_queries',
    description: 'Search query events with latency breakdown and result_count',
    defaultQuery: CH_DEFAULT_QUERY('abl_platform.search_queries'),
  },
];

export const ALLOWED_CLICKHOUSE_TABLE_NAMES: readonly string[] = ALLOWED_CLICKHOUSE_TABLES.map(
  (t) => t.name,
);

export const ALLOWED_MONGO_COLLECTION_NAMES: readonly string[] = ALLOWED_MONGO_COLLECTIONS.map(
  (c) => c.name,
);

/**
 * Operators explicitly forbidden — JS execution, schema inspection,
 * and aggregation-expression bypass of flat filter injection.
 */
// Array (not Set) — iterated via JSON.stringify scan in rejectForbiddenOperators().
export const FORBIDDEN_MONGO_OPERATORS: readonly string[] = [
  '$where',
  '$function',
  '$accumulator',
  '$expr',
  '$jsonSchema',
];
