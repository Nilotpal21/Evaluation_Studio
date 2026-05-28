/**
 * Workflow Engine Named Constants
 *
 * All magic numbers for timeouts, limits, and thresholds.
 * Import from here — never use inline numeric literals.
 */

/** Maximum number of steps per workflow */
export const MAX_WORKFLOW_STEPS = 50;

/** Maximum number of branches in a parallel step */
export const MAX_PARALLEL_BRANCHES = 10;

/** Default step timeout (1 minute) */
export const DEFAULT_STEP_TIMEOUT_MS = 60_000;

/** Agent invocation timeout (120 seconds — agents take longer) */
export const DEFAULT_AGENT_TIMEOUT_MS = 120_000;

/** Async webhook default timeout (24 hours) */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * B-2 migration note: the Restate-native `inactivity_timeout` (previously
 * enforced via the legacy runWorkflow path) was removed when the relay-race
 * executeWorkflow path was introduced. Its replacement is:
 *  - ADI:     poll-worker STEP_TIMEOUT callback (2 min default) + MAX_POLL_COUNT cap
 *  - Docling: BullMQ attempts (3) + StuckExecutionSweeper (STUCK_EXECUTION_MAX_AGE_MS, default 4h)
 *  - Approval/human-task: per-step timeoutMs (designer-configured, up to DEFAULT_APPROVAL_TIMEOUT_MS)
 * Workflows migrated from the legacy path retain their existing step-level
 * timeout configs — no data migration is required.
 */

/** Approval default timeout (72 hours) */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 72 * 60 * 60 * 1000;

/** Maximum delay duration (7 days) */
export const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Webhook/callback replay tolerance (5 minutes) */
export const CALLBACK_REPLAY_TOLERANCE_MS = 300_000;

/** Default port for the Restate service endpoint (HTTP/2, separate from Express) */
export const DEFAULT_RESTATE_ENDPOINT_PORT = 9081;

/** Graceful shutdown timeout */
export const SHUTDOWN_TIMEOUT_MS = 15_000;

/** Default pagination limit */
export const DEFAULT_PAGE_LIMIT = 50;

/** Maximum pagination limit */
export const MAX_PAGE_LIMIT = 200;

/** Maximum request payload size (1 MB) */
export const MAX_PAYLOAD_SIZE_BYTES = 1_048_576;

/** V8 isolate heap limit for function nodes (MB) */
export const FUNCTION_NODE_MEMORY_MB = 128;

/** Max JSON-serialized output size for function nodes (1 MB) */
export const FUNCTION_NODE_MAX_OUTPUT_BYTES = 1_048_576;

/** Max console log entries per function execution */
export const FUNCTION_NODE_MAX_LOGS = 100;

/**
 * HTTP timeout for a single workflow-memory operation (`projection`, `get`,
 * `set`, `delete`) issued from the workflow-engine to the runtime. Per LLD
 * §1.2 + Phase 4. Function-node isolate scripts call host async memory ops
 * via `ivm.Reference.applySyncPromise`; D-9 prototype confirmed that
 * `script.run({ timeout })` does NOT cancel the script while it's blocked
 * inside applySyncPromise — so the timeout MUST be enforced inside the
 * client's `fetch` call (`AbortSignal.timeout(MEMORY_OP_TIMEOUT_MS)`).
 */
export const MEMORY_OP_TIMEOUT_MS = 5000;

/** Connector polling worker concurrency */
export const POLLING_WORKER_CONCURRENCY = 5;

/** Timeout for design-time test runs (testSample / testAction) — 30 seconds */
export const DESIGN_TIME_TEST_TIMEOUT_MS = 30_000;

/** Maximum JSON-serialized size of a stored sample payload / sampleOutput (64 KB) */
export const MAX_SAMPLE_PAYLOAD_BYTES = 65_536;

/** Time conversion factors */
export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
