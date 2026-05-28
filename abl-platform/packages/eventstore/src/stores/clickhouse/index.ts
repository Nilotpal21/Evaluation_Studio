/**
 * ClickHouse event store implementation.
 *
 * Production storage backend with:
 * - BufferedClickHouseWriter (fire-and-forget, 10K batch / 5s flush)
 * - Hot/warm/cold tiered storage (30d → 90d → 730d DELETE)
 * - Tenant isolation (ORDER BY tenant_id, category, event_type, timestamp)
 * - Skip indexes for common query patterns
 * - Plan-based retention + GDPR compliance
 */

export { ClickHouseEventStore, type ClickHouseEventStoreConfig } from './clickhouse-event-store.js';
export { ClickHouseRowMapper, type ClickHouseEventRow } from './clickhouse-row-mapper.js';
export {
  PLATFORM_EVENTS_TABLE_DDL,
  PLATFORM_EVENTS_BY_SESSION_TABLE_DDL,
  PLATFORM_EVENTS_BY_SESSION_MV_DDL,
  SESSION_METRICS_DAILY_MV_DDL,
  LLM_COST_HOURLY_MV_DDL,
  getSessionMVDDLStatements,
} from './platform-events-table.js';
export {
  WORKFLOW_EXECUTION_EVENTS_TABLE_DDL,
  WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL,
  WORKFLOW_EXECUTIONS_LATEST_MV_DDL,
} from './workflow-execution-events-table.js';
export {
  HUMAN_TASK_EVENTS_TABLE_DDL,
  HUMAN_TASKS_LATEST_TABLE_DDL,
  HUMAN_TASKS_LATEST_MV_DDL,
} from './human-task-events-table.js';
