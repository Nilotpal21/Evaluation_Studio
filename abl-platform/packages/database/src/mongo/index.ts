/**
 * MongoDB Infrastructure — Public API
 *
 * All MongoDB-related exports for the ABL Platform database layer.
 */

// ─── Types ───────────────────────────────────────────────────────────────
export type { MongoDBConfig } from './types.js';

// ─── Connection ──────────────────────────────────────────────────────────
export {
  MongoConnectionManager,
  type ConnectionState,
  type HealthCheckResult,
  type PoolCheckoutFailureEvent,
  type PoolEventCallback,
} from './connection.js';

// ─── Base Document ───────────────────────────────────────────────────────
export {
  uuidv7,
  applyBaseSchema,
  applySoftDeleteSchema,
  applyTenantSchema,
  applyEncryptionSchema,
  baseSchemaFields,
  softDeleteSchemaFields,
  tenantSchemaFields,
  encryptionSchemaFields,
  type BaseDocument,
  type SoftDeletableDocument,
  type TenantScopedDocument,
  type EncryptedDocument,
  type PaginationOptions,
  type PaginatedResult,
  type CursorOptions,
  type CursorResult,
  type QueryOptions,
} from './base-document.js';

// ─── Base Model ──────────────────────────────────────────────────────────
export { BaseModel } from './base-model.js';

// ─── Plugins ─────────────────────────────────────────────────────────────
export {
  tenantIsolationPlugin,
  withTenantContext,
  getCurrentTenantContext,
  withSuperAdminContext,
  registerTenantContextProvider,
  type TenantContext,
} from './plugins/tenant-isolation.plugin.js';

export {
  encryptionPlugin,
  setMasterKey,
  _resetEncryptionStateForTesting,
  type EncryptionPluginOptions,
} from './plugins/encryption.plugin.js';

export {
  slowQueryPlugin,
  setSlowQueryThreshold,
  setSlowQueryLogHandler,
} from './plugins/slow-query.plugin.js';

export {
  auditTrailPlugin,
  withAuditActor,
  getCurrentAuditActor,
  setAuditHandler,
  type AuditActorContext,
} from './plugins/audit-trail.plugin.js';

export { leanIdPlugin } from './plugins/lean-id.plugin.js';
export {
  repairLegacyConnectorConnectionIndexes,
  reconcileConnectorConnectionIndexes,
} from './connector-connection-index-repair.js';
export {
  GUARDRAIL_POLICY_COLLECTION,
  LEGACY_GUARDRAIL_POLICY_UNIQUE_INDEX_KEY,
  SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_KEY,
  SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_NAME,
  findLegacyGuardrailPolicyUniqueIndexes,
  hasScopedGuardrailPolicyUniqueIndex,
  reconcileGuardrailPolicyUniqueIndexes,
  type GuardrailPolicyIndexReconciliationResult,
} from './guardrail-policy-index-repair.js';

// ─── Error Handling ──────────────────────────────────────────────────────
export {
  MongoAppError,
  MongoErrorCode,
  classifyError,
  wrapError,
  isRetryableError,
} from './middleware/error-handler.js';

// ─── Retry & Circuit Breaker ─────────────────────────────────────────────
export {
  withRetry,
  CircuitBreaker,
  CircuitBreakerOpenError,
  type RetryOptions,
  type CircuitBreakerOptions,
  type CircuitBreakerState,
} from './helpers/retry.js';

// ─── Pagination ──────────────────────────────────────────────────────────
export {
  buildOffsetPaginationPipeline,
  parseOffsetPaginationResult,
  buildCursorPaginationPipeline,
  parseCursorPaginationResult,
  normalizePaginationOptions,
  normalizeCursorOptions,
} from './helpers/pagination.js';

// ─── Aggregation ─────────────────────────────────────────────────────────
export {
  buildTenantPipeline,
  buildDateRangeStage,
  buildDateRangePipeline,
  buildPaginatedPipeline,
  buildTimeBucketPipeline,
  buildLookupStage,
  buildLookupOneStage,
  buildCountByFieldPipeline,
} from './helpers/aggregation.js';
