/**
 * Shared Constants
 *
 * Central location for all default port numbers and other shared constants
 * used across the ABL platform.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Default Ports
// ─────────────────────────────────────────────────────────────────────────────

/** Runtime API server default port */
export const DEFAULT_RUNTIME_PORT = 3112;

/** Studio (Next.js) default port */
export const DEFAULT_STUDIO_PORT = 5173;

/** Internal docs default port */
export const DEFAULT_DOCS_INTERNAL_PORT = 3007;

/** Template Store default port */
export const DEFAULT_TEMPLATE_STORE_PORT = 3115;

/** Academy Service default port */
export const DEFAULT_ACADEMY_PORT = 3116;

/** Alternative local development ports (for CORS, OAuth redirects, etc.) */
export const DEFAULT_LOCAL_PORTS = [
  DEFAULT_STUDIO_PORT, // 5173 - Studio
  DEFAULT_RUNTIME_PORT, // 3112 - Runtime
  3000, // Common Next.js default
  3001, // Alternative
  3007, // Docs Internal
  3115, // Template Store
  3116, // Academy Service
] as const;

/** Default localhost origins for development */
export const DEFAULT_LOCAL_ORIGINS = DEFAULT_LOCAL_PORTS.map((port) => `http://localhost:${port}`);

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure Ports (docker-compose host-mapped ports)
// ─────────────────────────────────────────────────────────────────────────────

/** Workflow Engine default port */
export const DEFAULT_WORKFLOW_ENGINE_PORT = 9080;

export const DEFAULT_MONGODB_PORT = 27018;
export const DEFAULT_CLICKHOUSE_PORT = 8124;
export const DEFAULT_REDIS_PORT = 6380;

// ─────────────────────────────────────────────────────────────────────────────
// Event Production (Runtime → Kafka)
// ─────────────────────────────────────────────────────────────────────────────

/** Default Kafka broker address for event production */
export const DEFAULT_KAFKA_BROKER = 'localhost:19092';

// ─────────────────────────────────────────────────────────────────────────────
// Omnichannel Session Continuity Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** Default maximum messages returned by recall */
export const OMNICHANNEL_RECALL_MAX_MESSAGES = 20;

/** Default maximum age in days for recall messages */
export const OMNICHANNEL_RECALL_MAX_AGE_DAYS = 30;

/** Recall query timeout in milliseconds */
export const OMNICHANNEL_RECALL_TIMEOUT_MS = 3000;

/** Maximum recall response payload size in bytes (64KB) */
export const OMNICHANNEL_RECALL_MAX_PAYLOAD_BYTES = 64 * 1024;

/** Session-start latency budget in milliseconds */
export const OMNICHANNEL_SESSION_START_BUDGET_MS = 1000;

/** Live session Redis key TTL (24 hours) */
export const OMNICHANNEL_LIVE_SESSION_TTL_SECONDS = 24 * 60 * 60;

/** Participant set Redis key TTL (4 hours, matches max session duration) */
export const OMNICHANNEL_PARTICIPANT_TTL_SECONDS = 4 * 60 * 60;

/** Join link TTL (default 10 minutes) */
export const OMNICHANNEL_JOIN_LINK_TTL_SECONDS = 600;

/** Sequence counter Redis key TTL (4 hours, matches participant set) */
export const OMNICHANNEL_SEQUENCE_TTL_SECONDS = 4 * 60 * 60;

/** Maximum connections per session (prevents tab-bomb abuse) */
export const OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Event Production (Runtime → Kafka)
// ─────────────────────────────────────────────────────────────────────────────

/** Kafka batch size — flush after this many events */
export const EVENT_KAFKA_BATCH_SIZE = 100;

/** Kafka linger time — flush after this many ms even if batch not full */
export const EVENT_KAFKA_LINGER_MS = 500;

/** Kafka retry count for failed batches */
export const EVENT_KAFKA_RETRIES = 3;

/** Kafka initial retry delay in ms (exponential backoff: 100 → 200 → 400) */
export const EVENT_KAFKA_RETRY_INITIAL_MS = 100;

/** Kafka shutdown timeout — max time to drain buffers on SIGTERM */
export const EVENT_KAFKA_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Subscription registry refresh interval — how often to re-query active pipelines */
export const EVENT_REGISTRY_SYNC_MS = 60_000;

/** Topic prefix for all platform business events */
export const EVENT_TOPIC_PREFIX = 'abl';

// ─────────────────────────────────────────────────────────────────────────────
// SDK Validation Limits
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum serialized byte size for the entire SDK userContext payload */
export const SDK_USER_CONTEXT_MAX_BYTES = 4096;

/** Maximum length for userContext.userId values accepted from SDK callers */
export const SDK_USER_CONTEXT_USER_ID_MAX_CHARS = 200;

/** Maximum number of customAttributes entries accepted from SDK callers */
export const SDK_USER_CONTEXT_MAX_ATTRIBUTES = 32;

/** Maximum length for a customAttributes key */
export const SDK_USER_CONTEXT_KEY_MAX_CHARS = 128;

/** Maximum length for a string customAttributes value */
export const SDK_USER_CONTEXT_STRING_MAX_CHARS = 512;

/** Maximum number of items allowed in an array customAttributes value */
export const SDK_USER_CONTEXT_ARRAY_MAX_ITEMS = 16;

/** Maximum nesting depth across the SDK userContext object graph */
export const SDK_USER_CONTEXT_MAX_DEPTH = 2;

/** Maximum length for an SDK bootstrap HMAC signature */
export const SDK_USER_CONTEXT_HMAC_MAX_CHARS = 128;

/** Exact hex length for the current SHA-256 SDK identity HMAC digest */
export const SDK_USER_CONTEXT_HMAC_HEX_CHARS = 64;

/** Largest accepted Unix-seconds timestamp for SDK bootstrap identity envelopes */
export const SDK_USER_CONTEXT_TIMESTAMP_MAX_SECONDS = 9_999_999_999;

// ─────────────────────────────────────────────────────────────────────────────
// Runtime Simulation / Test Session Limits
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum scripted user turns accepted by the runtime simulation endpoint. */
export const RUNTIME_SIMULATION_MAX_SCRIPTED_TURNS = 10;

/** Maximum DSL override payload accepted by the runtime simulation endpoint. */
export const RUNTIME_SIMULATION_MAX_DSL_OVERRIDE_BYTES = 250_000;

/** Maximum in-memory runtime test sessions retained per pod. */
export const RUNTIME_TEST_SESSION_MAX_SESSIONS = 1_000;

/** In-memory runtime test session idle TTL. */
export const RUNTIME_TEST_SESSION_TTL_MS = 60 * 60 * 1000;

/** Arch per-agent mutation lock TTL (hard ceiling enforced by Redis EXPIRE). */
export const ARCH_MUTATION_LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * Arch per-agent mutation lock soft-reclaim threshold.
 *
 * If a *different* session holds the lock and the lock was acquired more
 * than this many ms ago, the new acquire request will reclaim it (with a
 * warn log) instead of returning MUTATION_LOCKED. This catches the common
 * case where the owning session was abandoned (browser closed, network
 * blip, force-archived stuck session) without waiting for the full TTL.
 *
 * Must be < ARCH_MUTATION_LOCK_TTL_MS, and long enough that an attentive
 * user reviewing the diff doesn't get bumped mid-review.
 */
export const ARCH_MUTATION_LOCK_STALE_RECLAIM_MS = 5 * 60 * 1000;
